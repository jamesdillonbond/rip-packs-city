import { describe, it, expect } from "vitest"
import {
  GREETING_RE,
  classifyAnthropicError,
  CONCIERGE_ERROR_MESSAGES,
  type ConciergeErrorMode,
} from "@/lib/concierge/errors"

// Locks the concierge's Anthropic-error classifier. The load-bearing case is
// model_error: a retired model returns a 404 / not_found_error, and when that
// fell through to "unknown" the 2026-06-15 sonnet-4 retirement went unnoticed
// for ~7 days. These assertions keep each failure class mapped to the mode
// that drives the right user message + the LOUD pipeline_runs alert.

describe("classifyAnthropicError", () => {
  it("credit / auth / billing failures → credit_balance", () => {
    expect(classifyAnthropicError({ status: 401 })).toBe("credit_balance")
    expect(classifyAnthropicError({ status: 402 })).toBe("credit_balance")
    expect(classifyAnthropicError({ status: 403 })).toBe("credit_balance")
    expect(classifyAnthropicError({ type: "authentication_error" })).toBe("credit_balance")
    expect(classifyAnthropicError({ type: "permission_error" })).toBe("credit_balance")
    expect(
      classifyAnthropicError({ message: "Your credit balance is too low" })
    ).toBe("credit_balance")
    expect(
      classifyAnthropicError({ message: "invalid api key" })
    ).toBe("credit_balance")
  })

  it("model retirement (404 / not_found) → model_error, not unknown", () => {
    expect(classifyAnthropicError({ status: 404 })).toBe("model_error")
    expect(classifyAnthropicError({ type: "not_found_error" })).toBe("model_error")
    expect(
      classifyAnthropicError({ message: "model: claude-x has been retired" })
    ).toBe("model_error")
    expect(
      classifyAnthropicError({ message: "the model does not exist" })
    ).toBe("model_error")
  })

  it("reads nested Anthropic error type shapes", () => {
    expect(
      classifyAnthropicError({ error: { error: { type: "not_found_error" } } })
    ).toBe("model_error")
    expect(
      classifyAnthropicError({ error: { type: "rate_limit_error" } })
    ).toBe("rate_limit")
  })

  it("429 / rate_limit_error → rate_limit", () => {
    expect(classifyAnthropicError({ status: 429 })).toBe("rate_limit")
    expect(classifyAnthropicError({ type: "rate_limit_error" })).toBe("rate_limit")
    expect(classifyAnthropicError({ message: "rate limit exceeded" })).toBe("rate_limit")
  })

  it("5xx / overloaded / connection failures → overloaded", () => {
    expect(classifyAnthropicError({ status: 500 })).toBe("overloaded")
    expect(classifyAnthropicError({ status: 529 })).toBe("overloaded")
    expect(classifyAnthropicError({ type: "overloaded_error" })).toBe("overloaded")
    expect(classifyAnthropicError({ name: "APIConnectionTimeoutError" })).toBe("overloaded")
    expect(classifyAnthropicError({ message: "fetch failed" })).toBe("overloaded")
  })

  it("unrecognized failures → unknown", () => {
    expect(classifyAnthropicError({ status: 400 })).toBe("unknown")
    expect(classifyAnthropicError({})).toBe("unknown")
    expect(classifyAnthropicError(null)).toBe("unknown")
    expect(classifyAnthropicError("weird string error")).toBe("unknown")
  })

  it("precedence: credit_balance is checked before model_error", () => {
    // A 403 that also mentions a model is a billing/permission problem first.
    expect(
      classifyAnthropicError({ status: 403, message: "model not found" })
    ).toBe("credit_balance")
  })
})

describe("CONCIERGE_ERROR_MESSAGES", () => {
  const MODES: ConciergeErrorMode[] = [
    "credit_balance",
    "model_error",
    "rate_limit",
    "overloaded",
    "unknown",
  ]

  it("every mode has a non-empty response + category", () => {
    for (const mode of MODES) {
      const m = CONCIERGE_ERROR_MESSAGES[mode]
      expect(m.response.length).toBeGreaterThan(0)
      expect(m.category.length).toBeGreaterThan(0)
    }
  })

  it("model_error carries the distinct concierge_model_error category", () => {
    expect(CONCIERGE_ERROR_MESSAGES.model_error.category).toBe("concierge_model_error")
  })
})

describe("GREETING_RE", () => {
  it("matches bare greetings (case / punctuation / repetition tolerant)", () => {
    for (const g of ["hi", "Hello", "hey!!", "GM", "gn", "  sup ", "yo", "hola", "hiii"]) {
      expect(GREETING_RE.test(g)).toBe(true)
    }
  })

  it("does not match real questions", () => {
    for (const q of ["what is the fmv of lillard", "hi, can you find deals", "hey what's the floor"]) {
      expect(GREETING_RE.test(q)).toBe(false)
    }
  })
})
