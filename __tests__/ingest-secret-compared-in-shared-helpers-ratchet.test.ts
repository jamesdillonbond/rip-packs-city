import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

// ─────────────────────────────────────────────────────────────────────────────
// INGEST_SECRET_TOKEN / CRON_SECRET ARE COMPARED IN ONE PLACE — A RATCHET.
// (CISO pass 2026-11-04, API finding 7.)
//
// R134 (2026-10-25) moved every RPC_ADMIN_TOKEN compare into lib/auth/bearer-secret.ts
// (constant-time, by env NAME). The two cron/ingest secrets were not swept: on
// 2026-11-04, 41 tracked files under app/ and lib/ still compared one of them with
// `===` / `!==` on their own. Thirteen were converted that day; the rest sit behind the
// proxy wall (a caller needs the same secret to reach them) and a timing oracle through
// Vercel is impractical, so they are a RATCHET, not a ban at zero: the count may only
// FALL. Convert a route to `bearerMatches` / `tokenMatches` and lower CEILING.
//
// Scope: a file that READS one of the env vars and ALSO contains a local `===`/`!==`
// compare between two auth-shaped identifiers (expected/secret/token/bearer/qp/...).
// Forwarding a secret as a header, or a presence check, is not in the population.
// ─────────────────────────────────────────────────────────────────────────────

const READS = /process\.env\.(INGEST_SECRET_TOKEN|CRON_SECRET)\b/
const LOCAL_COMPARE =
  /process\.env\.(INGEST_SECRET_TOKEN|CRON_SECRET)\s*(===|!==)|(===|!==)\s*process\.env\.(INGEST_SECRET_TOKEN|CRON_SECRET)|\b(expected|secret|TOKEN|CRON|token|ingest|cron|tok|bearer|qp|urlToken|queryToken|provided)\w*\s*(===|!==)\s*(expected|secret|TOKEN|CRON|token|ingest|cron|tok|cronSecret|ingestToken)\b/

/** 2026-11-04 ~9:30 AM PT: 41 before the sweep, 37 after (13 sites converted, some files held several). Lower it; never raise it. */
const CEILING = 37

function tracked(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", "app", "lib", "components"], { encoding: "utf8" })
    .split("\0")
    .filter((f) => /\.(ts|tsx)$/.test(f) && f !== "lib/auth/bearer-secret.ts")
}

describe("ingest/cron secrets compared locally — ratchet", () => {
  const files = tracked()
  const population = files.filter((f) => {
    let src = ""
    try {
      src = readFileSync(f, "utf8")
    } catch {
      return false
    }
    return READS.test(src) && LOCAL_COMPARE.test(src)
  })

  it("inspects the tree (a walk that reads nothing passes vacuously)", () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it(`no more than ${CEILING} files compare a cron/ingest secret themselves`, () => {
    expect(population.length, population.join("\n")).toBeLessThanOrEqual(CEILING)
  })

  it("the pattern fires on the shapes it replaced (planted)", () => {
    const planted = [
      'if (searchParams.get("secret") !== process.env.INGEST_SECRET_TOKEN) {',
      'const expected = process.env.INGEST_SECRET_TOKEN\n  if (tok === expected) return true',
      '(bearer === process.env.INGEST_SECRET_TOKEN || bearer === process.env.CRON_SECRET)',
      'const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""\n  (TOKEN.length > 0 && (bearer === TOKEN || urlToken === TOKEN))',
    ]
    for (const p of planted) expect(READS.test(p) && LOCAL_COMPARE.test(p), p).toBe(true)
    // and does not fire on the shared-helper shape
    const clean = 'if (!bearerMatches(req.headers.get("authorization"), "INGEST_SECRET_TOKEN")) return unauthorized()\nconst t = process.env.INGEST_SECRET_TOKEN'
    expect(LOCAL_COMPARE.test(clean)).toBe(false)
  })
})
