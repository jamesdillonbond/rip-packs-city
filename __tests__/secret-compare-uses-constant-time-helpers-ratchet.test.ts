import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

/**
 * 2026-10-27 (review of the 10-25 security commits): 0be2325a8 routed every RPC_ADMIN_TOKEN check through the
 * constant-time helpers (lib/auth/bearer-secret.ts: bearerMatches / tokenMatches), but routes still compared the
 * INGEST / CRON secrets with `===` / `!==` against a `Bearer ${secret}` template. Nine admin routes were converted
 * in the same pass and the other 100 sites (61 files) by a scripted conversion that afternoon, so this is now a BAN AT
 * ZERO: a new route uses bearerMatches(header, "INGEST_SECRET_TOKEN", "CRON_SECRET") / tokenMatches(token, …).
 *
 * Population: DERIVED by a walk of app/, lib/ and proxy.ts (comments stripped with the one shared stripper).
 */
const BASELINE = 0  // 100 on 2026-10-27 ~11:10 AM PT; the rest converted the same day — now a ban at zero

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const files = [...walk(join(process.cwd(), "app")), ...walk(join(process.cwd(), "lib")), join(process.cwd(), "proxy.ts")]
const SHAPE = /(===|!==)\s*`Bearer \$\{/g

describe("secret comparisons use the constant-time helpers (ratchet)", () => {
  it("the walk inspected a real tree", () => {
    expect(files.length).toBeGreaterThan(500)
  })
  it(`at most ${BASELINE} \`=== \\\`Bearer \${…}\\\`\` comparisons remain (lower the baseline as they are fixed)`, () => {
    let n = 0
    const hits: string[] = []
    for (const f of files) {
      const m = stripComments(readFileSync(f, "utf8")).match(SHAPE)
      if (m) { n += m.length; hits.push(`${f.slice(process.cwd().length + 1)} ×${m.length}`) }
    }
    expect(n, hits.join("\n")).toBeLessThanOrEqual(BASELINE)
  })
})
