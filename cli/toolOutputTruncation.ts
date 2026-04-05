/**
 * Tool output truncation with head+tail strategy.
 *
 * Large tool outputs (shell commands, grep results, file reads) can consume
 * enormous context budgets — a single command can add 10K+ tokens, most of
 * which the model never uses. This module intercepts tool results before they
 * are appended to message history and trims them to a configurable token budget
 * while retaining the parts most likely to matter: the beginning (context /
 * headers / early errors) and the end (final results / last error lines).
 *
 * Design principles:
 *   - No API calls — token counts are estimated via a character-density heuristic.
 *   - Outputs below the threshold pass through completely unchanged.
 *   - Shell results preserve stderr and exit codes unconditionally; only stdout
 *     is eligible for truncation.
 *   - A small set of tools (Edit, Write, AskUser, …) are exempt because their
 *     outputs are either already short or must be read in full for correctness.
 *   - The truncation marker records line counts and token estimates so the model
 *     (and humans reviewing transcripts) can understand what was dropped.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default token threshold — outputs at or below this pass through unchanged. */
export const DEFAULT_TOKEN_THRESHOLD = 2_000

/** Default fraction of the budget kept from the head of the output. */
export const DEFAULT_HEAD_RATIO = 0.2

/**
 * ASCII character density heuristic: roughly 4 characters per token for
 * plain English / code text.
 */
const ASCII_CHARS_PER_TOKEN = 4

/**
 * Non-ASCII character density: roughly 0.77 characters per token on average
 * (CJK glyphs and other multibyte sequences require more bytes per codepoint).
 */
const NON_ASCII_CHARS_PER_TOKEN = 0.77

/** Number of characters sampled to determine the ASCII vs non-ASCII ratio. */
const SAMPLE_SIZE = 1_000

/**
 * Tools exempt from truncation. Their outputs are either inherently small
 * (Edit confirms a diff; AskUser echoes the answer) or must be read in full
 * for downstream correctness (Write, TodoWrite).
 */
export const TRUNCATION_EXEMPT_TOOLS = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'AskUser',
  'AskFollowupQuestion',
  'TodoRead',
  'TodoWrite',
])

// ─── Token estimation ─────────────────────────────────────────────────────────

/**
 * Estimate the token count of a string using a character-density heuristic.
 *
 * Samples the first SAMPLE_SIZE characters to determine the ASCII fraction,
 * then blends the ASCII and non-ASCII chars-per-token rates proportionally
 * before dividing the full string length by that blended rate.
 *
 * This is intentionally an approximation — the goal is a fast gate that avoids
 * unnecessary truncation of small outputs, not an exact token count.
 */
export function estimateTokenCount(text: string): number {
  if (text.length === 0) return 0

  const sample = text.slice(0, SAMPLE_SIZE)
  let asciiCount = 0
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) < 128) asciiCount++
  }

  const asciiRatio = asciiCount / sample.length
  const charsPerToken =
    asciiRatio * ASCII_CHARS_PER_TOKEN +
    (1 - asciiRatio) * NON_ASCII_CHARS_PER_TOKEN

  return Math.ceil(text.length / charsPerToken)
}

// ─── Head+tail truncation ─────────────────────────────────────────────────────

export type TruncationOptions = {
  /**
   * Maximum tokens before truncation is applied.
   * @default DEFAULT_TOKEN_THRESHOLD (2 000)
   */
  tokenThreshold?: number
  /**
   * Fraction of the token budget kept from the head of the output.
   * Must be in [0, 1]. The remainder goes to the tail.
   * @default DEFAULT_HEAD_RATIO (0.2)
   */
  headRatio?: number
}

/**
 * Truncate a string using a head+tail strategy.
 *
 * - Strings within the token threshold pass through unchanged.
 * - For larger strings: `headRatio * threshold` tokens are kept from the start;
 *   `(1 - headRatio) * threshold` tokens from the end. A descriptive marker is
 *   inserted between the two retained slices, reporting total line count and
 *   the estimated number of omitted tokens.
 *
 * Character slicing uses the ASCII chars-per-token rate as a conservative
 * upper bound — slightly over-preserving characters is safer than cutting too
 * aggressively.
 */
export function truncateToolOutput(
  text: string,
  options: TruncationOptions = {},
): string {
  const threshold = options.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD
  const headRatio = Math.max(0, Math.min(1, options.headRatio ?? DEFAULT_HEAD_RATIO))

  const estimated = estimateTokenCount(text)
  if (estimated <= threshold) return text

  const totalLines = text.split('\n').length

  const headTokens = Math.floor(threshold * headRatio)
  const tailTokens = threshold - headTokens

  // ASCII chars-per-token gives the most conservative (largest) character
  // estimate — we err toward keeping more context rather than less.
  const headChars = headTokens * ASCII_CHARS_PER_TOKEN
  const tailChars = tailTokens * ASCII_CHARS_PER_TOKEN

  const head = text.slice(0, headChars)
  const tail = text.length > tailChars ? text.slice(text.length - tailChars) : text

  const omittedTokens = estimated - threshold

  const marker = [
    '',
    `\u2502 [Output truncated: ${totalLines} lines total, ~${omittedTokens} tokens omitted]`,
    `\u2502 [Showing first ~${headTokens} tokens and last ~${tailTokens} tokens]`,
    '',
  ].join('\n')

  return head + marker + tail
}

// ─── Shell output handling ────────────────────────────────────────────────────

export type ShellOutput = {
  /** Standard output from the command. Subject to truncation. */
  stdout: string
  /** Standard error from the command. Always preserved in full. */
  stderr: string
  /** Process exit code. Always preserved. */
  exitCode: number
}

/**
 * Truncate shell command output while preserving stderr and exit code.
 *
 * Stderr and the exit code are diagnostic signals that must not be lost —
 * they are the primary indicators of command failure. Only stdout is
 * eligible for truncation.
 */
export function truncateShellOutput(
  output: ShellOutput,
  options: TruncationOptions = {},
): ShellOutput {
  return {
    ...output,
    stdout: truncateToolOutput(output.stdout, options),
  }
}

// ─── Primary entry point ──────────────────────────────────────────────────────

/**
 * Apply truncation to a tool result string, respecting tool exemptions.
 *
 * This is the function to call at the tool-result interception point before
 * appending to message history. Exempt tools return their output unchanged;
 * all others go through `truncateToolOutput`.
 *
 * @param toolName - The name of the tool that produced the output.
 * @param output   - The raw tool output string.
 * @param options  - Optional truncation configuration.
 * @returns The (possibly truncated) output string.
 */
export function applyToolOutputTruncation(
  toolName: string,
  output: string,
  options: TruncationOptions = {},
): string {
  if (TRUNCATION_EXEMPT_TOOLS.has(toolName)) return output
  return truncateToolOutput(output, options)
}
