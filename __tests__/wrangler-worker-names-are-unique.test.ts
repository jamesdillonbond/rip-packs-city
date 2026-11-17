import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

// BAN: no two `wrangler.toml` files may declare the same worker `name`.
//
// ── WHY, AND IT IS NOT HYGIENE ─────────────────────────────────────────────
// `name` is the Cloudflare worker a `wrangler deploy` writes to. Two configs
// sharing it means two divergent sources deploying to ONE live worker, and the
// last deploy wins with nothing in the repo recording which that was.
//
// Measured 2026-08-20, exactly one collision existed and it was live-dangerous:
//
//   workers/spork-proxy/wrangler.toml               name = "spork-proxy"   (255 lines)
//   infrastructure/spork-proxy-worker/wrangler.toml name = "spork-proxy"   ( 75 lines)
//
// The 255-line copy is the maintained one — referenced by ingest-allday-pack-opens
// and ingest-topshot-pack-opens-history ("must match workers/spork-proxy SPORKS"),
// by app/api/admin/backfill-topshot-buyers, and covered by
// __tests__/worker-spork-proxy.test.ts. It routes mainnet17–27 by height and
// serves a ?tx= lookup, extended on 2026-06-25 specifically to push the
// historical floor back to 2022-04-06.
//
// The 75-line copy is a 2026-04-27 fossil that knows only mainnet24–27 and is
// referenced by nothing but its own README. **A `wrangler deploy` run from that
// directory would have silently replaced the live worker with it** — removing
// the tx lookup and the reachability-floor guard, and breaking the pack-opens
// backfills without changing one line of application code.
// ⓘ 2026-08-30: the original wording said "removing mainnet17–23". Those nodes
// have since been decommissioned upstream (DNS ENOTFOUND), so that half of the
// consequence is now moot — but the ban still stands on the other half, and the
// live worker gained a floor guard the fossil does not have. Nothing in CI or the repo would have
// said so; the pipelines would simply have started failing to find history.
//
// Renamed rather than deleted (reversible, non-destructive); this ban keeps the
// class closed. ⚠ It is a ban at population ZERO, not a ratchet: there is no
// legitimate reason for two configs to claim one worker, so an exception should
// be argued, never defaulted to.

const ROOT = path.resolve(__dirname, "..")

/** `name = "..."` — the first assignment, ignoring commented-out lines. */
export function wranglerName(toml: string): string | null {
  for (const line of toml.split("\n")) {
    const t = line.trim()
    if (t.startsWith("#")) continue
    const m = /^name\s*=\s*["']([^"']+)["']/.exec(t)
    if (m) return m[1]
  }
  return null
}

function wranglerFiles(dir = ROOT, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".next") continue
    const p = path.join(dir, entry)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) wranglerFiles(p, out, depth + 1)
    else if (entry === "wrangler.toml") out.push(path.relative(ROOT, p).split(path.sep).join("/"))
  }
  return out
}

describe("every wrangler.toml declares a UNIQUE worker name", () => {
  it("the walk found the worker configs (not vacuously passing)", () => {
    // ⚠ On the ENUMERATOR — a ban at zero violations must still prove it looked.
    // Measured 2026-08-20: 19 configs.
    const files = wranglerFiles()
    expect(files.length, "no wrangler.toml found at all").toBeGreaterThan(10)
    expect(files.filter((f) => wranglerName(readFileSync(path.join(ROOT, f), "utf8")) !== null).length)
      .toBeGreaterThan(10)
  })

  it("no two configs deploy to the same Cloudflare worker", () => {
    const byName = new Map<string, string[]>()
    for (const f of wranglerFiles()) {
      const name = wranglerName(readFileSync(path.join(ROOT, f), "utf8"))
      if (!name) continue
      byName.set(name, [...(byName.get(name) ?? []), f])
    }
    const dupes = [...byName.entries()].filter(([, fs]) => fs.length > 1)
    expect(
      dupes.map(([n, fs]) => `${n}: ${fs.join(" , ")}`),
      "two configs deploy to one worker — the last deploy silently wins and the repo cannot say which ran",
    ).toEqual([])
  })

  // ── guards-the-guard ──────────────────────────────────────────────────────

  it("reads the name, and ignores a COMMENTED-OUT one", () => {
    // The fossil's fix put a long comment block directly above its `name`, and a
    // naive first-match-anywhere parser reads a `#`-prefixed line as the value.
    expect(wranglerName(`name = "a"`)).toBe("a")
    expect(wranglerName(`# name = "old-name"\nname = "new-name"`)).toBe("new-name")
    expect(wranglerName(`  name = 'single'`)).toBe("single")
    expect(wranglerName(`main = "index.ts"`)).toBeNull()
  })

  it("detects a collision when one exists", () => {
    // Pinned as behaviour, not by re-reading the tree: at a population of zero
    // the check above proves nothing about its ability to FIND a duplicate.
    const byName = new Map<string, string[]>()
    for (const [f, toml] of [
      ["a/wrangler.toml", `name = "dup"`],
      ["b/wrangler.toml", `name = "dup"`],
      ["c/wrangler.toml", `name = "unique"`],
    ] as const) {
      const n = wranglerName(toml)!
      byName.set(n, [...(byName.get(n) ?? []), f])
    }
    const dupes = [...byName.entries()].filter(([, fs]) => fs.length > 1)
    expect(dupes).toHaveLength(1)
    expect(dupes[0][0]).toBe("dup")
  })

  it("the spork fossil no longer claims the live worker's name", () => {
    // The specific collision this file was written for. Named because the
    // consequence is silent and severe: the live proxy would lose mainnet17–23.
    const live = wranglerName(readFileSync(path.join(ROOT, "workers/spork-proxy/wrangler.toml"), "utf8"))
    const fossil = wranglerName(readFileSync(path.join(ROOT, "infrastructure/spork-proxy-worker/wrangler.toml"), "utf8"))
    expect(live).toBe("spork-proxy")
    expect(fossil).not.toBe(live)
  })
})
