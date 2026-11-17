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
// `===` / `!==` on their own. Thirteen were converted that morning and the remaining 24
// at ~10:40 AM PT the same day, so this is now a BAN AT ZERO in ratchet clothing: a new
// route that compares either secret itself fails here. Use `bearerMatches` (full header)
// or `tokenMatches` (bare token) from lib/auth/bearer-secret.ts — both constant-time and
// fail-closed when the env var is unset.
//
// Scope: a file that READS one of the env vars and ALSO contains a local `===`/`!==`
// compare between two auth-shaped identifiers (expected/secret/token/bearer/qp/...).
// Forwarding a secret as a header, or a presence check, is not in the population.
// ─────────────────────────────────────────────────────────────────────────────

const READS = /process\.env\.(INGEST_SECRET_TOKEN|CRON_SECRET)\b/
const LOCAL_COMPARE =
  /process\.env\.(INGEST_SECRET_TOKEN|CRON_SECRET)\s*(===|!==)|(===|!==)\s*process\.env\.(INGEST_SECRET_TOKEN|CRON_SECRET)|\b(expected|secret|TOKEN|CRON|token|ingest|cron|tok|bearer|qp|urlToken|queryToken|provided)\w*\s*(===|!==)\s*(expected|secret|TOKEN|CRON|token|ingest|cron|tok|cronSecret|ingestToken)\b/
// ⚠ WIDENED 2026-11-07: the identifier alternation above anchors the LEFT side on a
// name that STARTS with token/secret/…, so `receivedToken === ingestToken`
// (fmv-recalc, fmv-backfill) and `authHeader.slice(7) === cronSecret`
// (evm-transfers-ingest) passed the "0 remaining" sweep untouched — fmv-recalc
// also logged 8 characters of the secret on every request. A compare whose either
// side is an identifier ENDING in Secret/Token (any case) is now in the population.
const SECRET_NAMED_COMPARE =
  /(===|!==)\s*[A-Za-z_]\w*(?:Secret|Token|SECRET|TOKEN)\b(?!\s*\()|\b[A-Za-z_]\w*(?:Secret|Token|SECRET|TOKEN)\s*(===|!==)\s*(?!(?:undefined|null|true|false)\b)[A-Za-z_(]/

/** 2026-11-04: 41 before the sweep, 37 at ~9:30 AM PT, 0 at ~10:40 AM PT. Never raise it. */
const CEILING = 0

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
    return READS.test(src) && (LOCAL_COMPARE.test(src) || SECRET_NAMED_COMPARE.test(src))
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
    // 2026-11-07: the three shapes the identifier pattern missed
    const missed = [
      'const ingestToken = process.env.INGEST_SECRET_TOKEN\n  const ok = receivedToken === ingestToken',
      'const cronSecret = process.env.CRON_SECRET;\n  if (authHeader.slice(7) === cronSecret) return true',
      'const cronSecret = process.env.CRON_SECRET\n  (cronSecret && receivedToken === cronSecret)',
      'const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN\n  if (!INGEST_TOKEN || token !== INGEST_TOKEN) {',
    ]
    for (const p of missed) expect(READS.test(p) && (LOCAL_COMPARE.test(p) || SECRET_NAMED_COMPARE.test(p)), p).toBe(true)
    expect(missed.some((p) => LOCAL_COMPARE.test(p) && !SECRET_NAMED_COMPARE.test(p))).toBe(false)
    // and does not fire on the shared-helper shape
    const clean = 'if (!bearerMatches(req.headers.get("authorization"), "INGEST_SECRET_TOKEN")) return unauthorized()\nconst t = process.env.INGEST_SECRET_TOKEN'
    expect(LOCAL_COMPARE.test(clean)).toBe(false)
    expect(SECRET_NAMED_COMPARE.test(clean)).toBe(false)
    // and not on a presence / literal check
    expect(SECRET_NAMED_COMPARE.test('if (cronSecret === undefined) return\nif (token === "") return')).toBe(false)
  })
})
