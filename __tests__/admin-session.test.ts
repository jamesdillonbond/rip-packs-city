import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createHmac } from "node:crypto"
import { NextRequest } from "next/server"
import { mintAdminSession, verifyAdminSession, ADMIN_SESSION_TTL_MS, ADMIN_SESSION_PREFIX } from "@/lib/admin-session"
import { bearerMatches, tokenMatches } from "@/lib/auth/bearer-secret"
import { verifyAdminRequest, isAdminCredential } from "@/lib/admin-auth"
import { POST as mintRoute } from "@/app/api/admin/session/route"

// Security audit 2026-10-25, R134 step 2: the admin pages store a 12 h signed
// session instead of the master RPC_ADMIN_TOKEN.

const MASTER = "test-master-admin-token-0123456789"
const orig = { ...process.env }

beforeEach(() => {
  process.env.RPC_ADMIN_TOKEN = MASTER
})
afterEach(() => {
  process.env = { ...orig }
})

function req(url: string, init: { headers?: Record<string, string>; body?: unknown } = {}) {
  return new NextRequest(url, {
    method: init.body === undefined ? "GET" : "POST",
    headers: init.headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

describe("lib/admin-session", () => {
  it("mints a session that verifies against the same master and nothing else", () => {
    const m = mintAdminSession(MASTER, 1_800_000_000_000)!
    expect(m.session.startsWith(ADMIN_SESSION_PREFIX)).toBe(true)
    expect(m.expiresAt).toBe(1_800_000_000_000 + ADMIN_SESSION_TTL_MS)
    expect(verifyAdminSession(m.session, MASTER, 1_800_000_000_000)).toBe(true)
    // Rotating the master token kills every outstanding session.
    expect(verifyAdminSession(m.session, MASTER + "x", 1_800_000_000_000)).toBe(false)
  })

  it("its signature is a real HMAC-SHA256 (cross-checked against node:crypto, not just round-tripped)", () => {
    const m = mintAdminSession(MASTER, 1_800_000_000_000)!
    const exp = m.expiresAt
    const want = createHmac("sha256", MASTER).update(`rpc-admin-session:v1:${exp}`).digest("base64url")
    expect(m.session).toBe(`${ADMIN_SESSION_PREFIX}${exp}.${want}`)
  })

  it("rejects expired, far-future, tampered and malformed values, and fails closed with no master", () => {
    const now = 1_800_000_000_000
    const m = mintAdminSession(MASTER, now)!
    expect(verifyAdminSession(m.session, MASTER, m.expiresAt + 1)).toBe(false) // expired
    const [, , sig] = m.session.split(".")
    const farExp = now + 30 * ADMIN_SESSION_TTL_MS
    const far = `${ADMIN_SESSION_PREFIX}${farExp}.${createHmac("sha256", MASTER).update(`rpc-admin-session:v1:${farExp}`).digest("base64url")}`
    expect(verifyAdminSession(far, MASTER, now)).toBe(false) // never minted that far out
    expect(verifyAdminSession(`${ADMIN_SESSION_PREFIX}${m.expiresAt + 1}.${sig}`, MASTER, now)).toBe(false) // expiry edited
    expect(verifyAdminSession(m.session.slice(0, -1) + "A", MASTER, now)).toBe(false)
    for (const bad of ["", "rpcadm1.", "rpcadm1.abc.def", "rpcadm1.123.x", MASTER, null, undefined]) {
      expect(verifyAdminSession(bad as string, MASTER, now)).toBe(false)
    }
    expect(verifyAdminSession(m.session, "", now)).toBe(false)
    expect(verifyAdminSession(m.session, undefined, now)).toBe(false)
    expect(mintAdminSession(undefined)).toBeNull()
  })
})

describe("where the admin token is accepted, a session is accepted — header form only", () => {
  it("bearerMatches / verifyAdminRequest take a live session; tokenMatches (?token=, cookie) does not", () => {
    const { session } = mintAdminSession(MASTER)!
    expect(bearerMatches(`Bearer ${session}`, "RPC_ADMIN_TOKEN")).toBe(true)
    expect(bearerMatches(`Bearer ${session}`, "INGEST_SECRET_TOKEN", "RPC_ADMIN_TOKEN")).toBe(true)
    expect(verifyAdminRequest(req("https://t/api/admin/x", { headers: { authorization: `Bearer ${session}` } }))).toBe(true)
    expect(tokenMatches(session, "RPC_ADMIN_TOKEN")).toBe(false)
    expect(verifyAdminRequest(req(`https://t/api/admin/x?token=${encodeURIComponent(session)}`))).toBe(false)
  })

  it("a session is NOT a credential for any other secret name", () => {
    process.env.INGEST_SECRET_TOKEN = MASTER // even when the values coincide
    const { session } = mintAdminSession(MASTER)!
    expect(bearerMatches(`Bearer ${session}`, "INGEST_SECRET_TOKEN")).toBe(false)
    expect(bearerMatches(`Bearer ${session}`, "CRON_SECRET")).toBe(false)
  })

  it("the master token still works everywhere it did (scripts, cron-job.org)", () => {
    expect(bearerMatches(`Bearer ${MASTER}`, "RPC_ADMIN_TOKEN")).toBe(true)
    expect(verifyAdminRequest(req(`https://t/api/admin/x?token=${MASTER}`))).toBe(true)
  })

  it("isAdminCredential (the flowty-errors cookie) takes master or session, fails closed when unset", () => {
    const { session } = mintAdminSession(MASTER)!
    expect(isAdminCredential(MASTER)).toBe(true)
    expect(isAdminCredential(session)).toBe(true)
    expect(isAdminCredential("nope")).toBe(false)
    delete process.env.RPC_ADMIN_TOKEN
    expect(isAdminCredential(session)).toBe(false)
    expect(isAdminCredential("")).toBe(false)
  })
})

describe("POST /api/admin/session", () => {
  it("exchanges the master token for a verifying session", async () => {
    const res = await mintRoute(req("https://t/api/admin/session", { body: { token: MASTER } }))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = (await res.json()) as { session: string; expires_at: string }
    expect(verifyAdminSession(body.session, MASTER)).toBe(true)
  })

  it("⛔ refuses a SESSION (a stolen one cannot renew itself), a wrong token, and an unset master", async () => {
    const { session } = mintAdminSession(MASTER)!
    expect((await mintRoute(req("https://t/api/admin/session", { body: { token: session } }))).status).toBe(401)
    expect((await mintRoute(req("https://t/api/admin/session", { body: { token: "wrong" } }))).status).toBe(401)
    delete process.env.RPC_ADMIN_TOKEN
    expect((await mintRoute(req("https://t/api/admin/session", { body: { token: MASTER } }))).status).toBe(401)
  })
})
