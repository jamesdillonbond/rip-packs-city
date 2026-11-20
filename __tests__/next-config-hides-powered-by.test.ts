import { describe, it, expect } from "vitest"
import nextConfig from "../next.config"

// The framework banner is off (2026-11-19). Next sends `X-Powered-By: Next.js` unless
// `poweredByHeader` is false; the live read before this change showed the header on `/`.
describe("next.config", () => {
  it("does not advertise the framework in a response header", () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })
})
