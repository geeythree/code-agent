/**
 * Unit tests for cli/toolOutputTruncation.ts
 *
 * Coverage goals:
 *   - estimateTokenCount: ASCII, non-ASCII, mixed, empty, and boundary strings
 *   - truncateToolOutput: pass-through below threshold, head+tail split, marker
 *     content, custom options, edge cases (ratio=0, ratio=1, very short output)
 *   - truncateShellOutput: stdout truncated, stderr/exitCode preserved
 *   - applyToolOutputTruncation: exempt tools, non-exempt tools, options forwarded
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_HEAD_RATIO,
  DEFAULT_TOKEN_THRESHOLD,
  TRUNCATION_EXEMPT_TOOLS,
  applyToolOutputTruncation,
  estimateTokenCount,
  truncateShellOutput,
  truncateToolOutput,
} from './toolOutputTruncation.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a string of `n` ASCII characters. */
function asciiString(n: number): string {
  return 'a'.repeat(n)
}

/** Build a string of `n` CJK characters (each is non-ASCII, ~1 token/char). */
function cjkString(n: number): string {
  // U+4E2D is '中', a common CJK character.
  return '\u4e2d'.repeat(n)
}

// ─── estimateTokenCount ───────────────────────────────────────────────────────

describe('estimateTokenCount', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokenCount('')).toBe(0)
  })

  it('estimates ASCII text at ~4 chars per token', () => {
    // 400 ASCII chars ÷ 4 = 100 tokens
    const tokens = estimateTokenCount(asciiString(400))
    expect(tokens).toBe(100)
  })

  it('estimates pure ASCII string of 1 char as 1 token', () => {
    expect(estimateTokenCount('x')).toBe(1)
  })

  it('estimates large ASCII strings proportionally', () => {
    // 8 000 chars → 2 000 tokens
    const tokens = estimateTokenCount(asciiString(8_000))
    expect(tokens).toBe(2_000)
  })

  it('estimates non-ASCII (CJK) text at a higher token density', () => {
    // CJK chars-per-token ≈ 0.77, so 100 CJK chars → ceil(100/0.77) ≈ 130 tokens
    const tokens = estimateTokenCount(cjkString(100))
    // Should be substantially more than 25 (the ASCII estimate would be)
    expect(tokens).toBeGreaterThan(50)
    // And in the rough ballpark of 130
    expect(tokens).toBeLessThanOrEqual(150)
  })

  it('uses only the first 1000 chars to determine the character ratio', () => {
    // Build a 2000-char string: first 1000 are ASCII, next 1000 are CJK.
    // The sampler only sees the ASCII half → estimate should behave like ASCII.
    const mixed = asciiString(1_000) + cjkString(1_000)
    const pureAscii = asciiString(2_000)
    // Both strings have the same length; the mixed one encodes the CJK half
    // with the ASCII density because only the first 1000 chars are sampled.
    // They should produce similar (not wildly different) estimates.
    const mixedTokens = estimateTokenCount(mixed)
    const asciiTokens = estimateTokenCount(pureAscii)
    expect(Math.abs(mixedTokens - asciiTokens)).toBeLessThan(200)
  })

  it('handles strings exactly at the sample boundary (1000 chars)', () => {
    // Should not throw or produce NaN
    const tokens = estimateTokenCount(asciiString(1_000))
    expect(tokens).toBeGreaterThan(0)
    expect(Number.isFinite(tokens)).toBe(true)
  })
})

// ─── truncateToolOutput ───────────────────────────────────────────────────────

describe('truncateToolOutput', () => {
  it('returns the original string when below the token threshold', () => {
    // 100 ASCII chars → 25 tokens, well below 2 000
    const small = asciiString(100)
    expect(truncateToolOutput(small)).toBe(small)
  })

  it('returns the original string when exactly at the threshold', () => {
    // Exactly DEFAULT_TOKEN_THRESHOLD tokens worth of ASCII chars
    const atThreshold = asciiString(DEFAULT_TOKEN_THRESHOLD * 4)
    expect(truncateToolOutput(atThreshold)).toBe(atThreshold)
  })

  it('truncates output that exceeds the threshold', () => {
    // 2× the threshold → should be truncated
    const big = asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 2)
    const result = truncateToolOutput(big)
    expect(result.length).toBeLessThan(big.length)
  })

  it('inserts a truncation marker between head and tail', () => {
    const big = asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 2)
    const result = truncateToolOutput(big)
    expect(result).toContain('Output truncated')
    expect(result).toContain('tokens omitted')
  })

  it('marker includes total line count', () => {
    // 3 lines, oversized
    const text = ('x'.repeat(5_000) + '\n').repeat(3)
    const result = truncateToolOutput(text)
    expect(result).toMatch(/\d+ lines total/)
  })

  it('marker reports head and tail token counts', () => {
    const big = asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 2)
    const result = truncateToolOutput(big)
    const headTokens = Math.floor(DEFAULT_TOKEN_THRESHOLD * DEFAULT_HEAD_RATIO)
    const tailTokens = DEFAULT_TOKEN_THRESHOLD - headTokens
    expect(result).toContain(`~${headTokens} tokens`)
    expect(result).toContain(`~${tailTokens} tokens`)
  })

  it('head slice starts from the beginning of the string', () => {
    const big = 'START' + asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 2) + 'END'
    const result = truncateToolOutput(big)
    expect(result.startsWith('START')).toBe(true)
  })

  it('tail slice ends at the end of the string', () => {
    const big = 'START' + asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 2) + 'END'
    const result = truncateToolOutput(big)
    expect(result.endsWith('END')).toBe(true)
  })

  it('respects a custom tokenThreshold', () => {
    const smallThreshold = 100
    // 200 ASCII chars → 50 tokens → above 100-token threshold? No: 50 < 100.
    // Use 500 chars → 125 tokens → above 100.
    const text = asciiString(500)
    const result = truncateToolOutput(text, { tokenThreshold: smallThreshold })
    expect(result).toContain('Output truncated')
  })

  it('does not truncate when tokenThreshold is very large', () => {
    const text = asciiString(1_000)
    const result = truncateToolOutput(text, { tokenThreshold: 1_000_000 })
    expect(result).toBe(text)
  })

  it('respects a custom headRatio of 0 (all tail)', () => {
    const big = 'HEAD' + asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 2) + 'TAIL'
    const result = truncateToolOutput(big, { headRatio: 0 })
    // Head slice is 0 chars → result should not start with 'HEAD'
    // (the marker comes immediately, then the tail portion)
    expect(result).toContain('TAIL')
    expect(result).toContain('Output truncated')
  })

  it('respects a custom headRatio of 1 (all head)', () => {
    const big = 'HEAD' + asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 2) + 'TAIL'
    const result = truncateToolOutput(big, { headRatio: 1 })
    // Tail budget is 0, so tail is the full string (slicing from length-0 returns the whole string).
    // The important thing is the marker appears and no crash occurs.
    expect(result).toContain('Output truncated')
    expect(result).toContain('HEAD')
  })

  it('handles an empty string without errors', () => {
    expect(truncateToolOutput('')).toBe('')
  })

  it('handles a single-character string without errors', () => {
    expect(truncateToolOutput('x')).toBe('x')
  })

  it('clamps headRatio values outside [0,1]', () => {
    const big = asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 2)
    // Should not throw for out-of-range ratios
    expect(() => truncateToolOutput(big, { headRatio: -1 })).not.toThrow()
    expect(() => truncateToolOutput(big, { headRatio: 2 })).not.toThrow()
  })

  it('works correctly with non-ASCII (CJK) content', () => {
    // CJK is denser in tokens, so fewer chars needed to exceed the threshold.
    // 2000 CJK chars → ~2597 tokens → above DEFAULT_TOKEN_THRESHOLD
    const cjk = cjkString(2_000)
    const result = truncateToolOutput(cjk)
    expect(result).toContain('Output truncated')
    expect(result.length).toBeLessThan(cjk.length)
  })

  it('truncated output is shorter than the original', () => {
    const big = asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 3)
    const result = truncateToolOutput(big)
    expect(result.length).toBeLessThan(big.length)
  })
})

// ─── truncateShellOutput ──────────────────────────────────────────────────────

describe('truncateShellOutput', () => {
  const bigStdout = asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 2)
  const stderr = 'error: something went wrong\nfatal: cannot continue'
  const exitCode = 1

  it('truncates stdout when it exceeds the threshold', () => {
    const result = truncateShellOutput({ stdout: bigStdout, stderr, exitCode })
    expect(result.stdout).toContain('Output truncated')
    expect(result.stdout.length).toBeLessThan(bigStdout.length)
  })

  it('preserves stderr in full, regardless of size', () => {
    const longStderr = asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 5)
    const result = truncateShellOutput({
      stdout: bigStdout,
      stderr: longStderr,
      exitCode,
    })
    // stderr must be returned exactly as-is
    expect(result.stderr).toBe(longStderr)
  })

  it('preserves exitCode regardless of stdout size', () => {
    const result = truncateShellOutput({ stdout: bigStdout, stderr, exitCode })
    expect(result.exitCode).toBe(exitCode)
  })

  it('preserves a non-zero exitCode', () => {
    const result = truncateShellOutput({ stdout: bigStdout, stderr, exitCode: 127 })
    expect(result.exitCode).toBe(127)
  })

  it('does not truncate small stdout', () => {
    const small = asciiString(100)
    const result = truncateShellOutput({ stdout: small, stderr, exitCode: 0 })
    expect(result.stdout).toBe(small)
  })

  it('passes options through to truncateToolOutput', () => {
    const smallThreshold = 50 // very low threshold
    const text = asciiString(300) // 75 tokens → above 50
    const result = truncateShellOutput(
      { stdout: text, stderr: '', exitCode: 0 },
      { tokenThreshold: smallThreshold },
    )
    expect(result.stdout).toContain('Output truncated')
  })

  it('handles empty stdout without errors', () => {
    const result = truncateShellOutput({ stdout: '', stderr: 'err', exitCode: 1 })
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('err')
    expect(result.exitCode).toBe(1)
  })
})

// ─── applyToolOutputTruncation ────────────────────────────────────────────────

describe('applyToolOutputTruncation', () => {
  const bigOutput = asciiString(DEFAULT_TOKEN_THRESHOLD * 4 * 2)

  it('truncates output for a non-exempt tool', () => {
    const result = applyToolOutputTruncation('Bash', bigOutput)
    expect(result).toContain('Output truncated')
    expect(result.length).toBeLessThan(bigOutput.length)
  })

  it('passes through output for every exempt tool unchanged', () => {
    for (const tool of TRUNCATION_EXEMPT_TOOLS) {
      expect(applyToolOutputTruncation(tool, bigOutput)).toBe(bigOutput)
    }
  })

  it('is case-sensitive — "edit" (lowercase) is not exempt', () => {
    const result = applyToolOutputTruncation('edit', bigOutput)
    // 'edit' ≠ 'Edit' → should be truncated
    expect(result).toContain('Output truncated')
  })

  it('forwards custom options to truncateToolOutput', () => {
    const smallThreshold = 50
    const text = asciiString(300) // 75 tokens
    const result = applyToolOutputTruncation('Bash', text, {
      tokenThreshold: smallThreshold,
    })
    expect(result).toContain('Output truncated')
  })

  it('does not truncate small output from non-exempt tools', () => {
    const small = asciiString(100) // 25 tokens, well below threshold
    expect(applyToolOutputTruncation('Bash', small)).toBe(small)
  })

  it('handles unknown tool names without throwing', () => {
    expect(() =>
      applyToolOutputTruncation('SomeUnknownTool', bigOutput),
    ).not.toThrow()
  })

  it('handles an empty tool name without throwing', () => {
    expect(() => applyToolOutputTruncation('', bigOutput)).not.toThrow()
  })

  it('handles empty output for any tool without throwing', () => {
    expect(applyToolOutputTruncation('Bash', '')).toBe('')
    expect(applyToolOutputTruncation('Edit', '')).toBe('')
  })
})

// ─── TRUNCATION_EXEMPT_TOOLS set ─────────────────────────────────────────────

describe('TRUNCATION_EXEMPT_TOOLS', () => {
  it('includes Edit', () => {
    expect(TRUNCATION_EXEMPT_TOOLS.has('Edit')).toBe(true)
  })

  it('includes Write', () => {
    expect(TRUNCATION_EXEMPT_TOOLS.has('Write')).toBe(true)
  })

  it('includes AskUser', () => {
    expect(TRUNCATION_EXEMPT_TOOLS.has('AskUser')).toBe(true)
  })

  it('does not include Bash', () => {
    expect(TRUNCATION_EXEMPT_TOOLS.has('Bash')).toBe(false)
  })

  it('does not include Grep', () => {
    expect(TRUNCATION_EXEMPT_TOOLS.has('Grep')).toBe(false)
  })

  it('does not include Read', () => {
    expect(TRUNCATION_EXEMPT_TOOLS.has('Read')).toBe(false)
  })
})
