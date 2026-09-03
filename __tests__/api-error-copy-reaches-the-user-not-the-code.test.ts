import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { apiErrorMessage } from "@/lib/api-error-message"

// ─────────────────────────────────────────────────────────────────────────────
// A route that writes human copy and a client that throws the machine code.
//
// Several routes deliberately send BOTH — `/api/profile/resolve-and-associate`
// answers a wallet-cap rejection with `{ error: "plan_limit_reached", message:
// "Free plan supports 3 saved wallets. Remove the wallet you have saved, or
// upgrade to RPC Pro.", upgrade_url: "/pricing" }`. `DashboardClient` threw
// `data.error` at FIVE call sites, so the user saw the literal string
// **"plan_limit_reached"** while the sentence written for them sat unused in the
// same response. ⭐ The copy existed, was correct, and never reached anybody.
//
// ⚠ `error` is NOT always a slug — most routes put human text there — so the
// rule is PREFER `message`, fall back to `error`. That is a strict improvement:
// routes sending only `error` behave exactly as before.
//
// ⓘ Unlike `/login?error=`, this body is our own API's response, not a query
// string. There is nothing attacker-controlled to allowlist; the defect is a
// DISCARDED field, not an injected one, and the fix differs accordingly.
// ─────────────────────────────────────────────────────────────────────────────

describe("apiErrorMessage", () => {
  it("prefers the human message over the machine code — the defect", () => {
    const body = {
      error: "plan_limit_reached",
      message: "Free plan supports 3 saved wallets. Remove the wallet you have saved, or upgrade to RPC Pro.",
      upgrade_url: "/pricing",
    }
    const out = apiErrorMessage(body, 402)
    expect(out).toBe(body.message)
    // Stated as an ABSENCE: this is the string a user was actually shown.
    expect(out, "the machine code must not reach the user").not.toContain("plan_limit_reached")
  })

  it("NO-CHANGE CONTROL: a route that sends only `error` is unaffected", () => {
    // Most routes put human text in `error`. If this regressed them the fix
    // would be a downgrade dressed as an improvement.
    const body = { error: "Couldn't find that Dapper username. Double-check spelling." }
    expect(apiErrorMessage(body, 404)).toBe(body.error)
  })

  it("falls back to the status when the body carries neither", () => {
    expect(apiErrorMessage({}, 500)).toBe("HTTP 500")
    expect(apiErrorMessage(null, 503)).toBe("HTTP 503")
    expect(apiErrorMessage(undefined, 400)).toBe("HTTP 400")
  })

  it("ignores empty and non-string fields rather than showing a blank error", () => {
    // An empty string is falsy-but-present; returning it would render an error
    // box with nothing in it, which tells the user less than the status does.
    expect(apiErrorMessage({ message: "   ", error: "real text" }, 400)).toBe("real text")
    expect(apiErrorMessage({ message: "", error: "" }, 400)).toBe("HTTP 400")
    expect(apiErrorMessage({ message: 42, error: null }, 400)).toBe("HTTP 400")
  })

  it("every DashboardClient throw site uses it — all five, not the one that was reported", () => {
    // The handoff named the wallet-cap path. The same expression was at five
    // sites, and fixing only the reported one is how a class survives a fix.
    const src = readFileSync(join(process.cwd(), "app/dashboard/DashboardClient.tsx"), "utf8")
    const used = src.split("apiErrorMessage(data, res.status)").length - 1
    expect(used).toBe(5)
    expect(src).not.toMatch(/data\.error \|\| `HTTP/)
  })
})
