import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// WHY THIS EXISTS (2026-09-22).
// get_fmv_for_editions is a SET-RETURNING RPC. PostgREST clamps every RPC result to
// max-rows = 1000, silently — no error, no header the callers read. compute-allday-pack-ev
// passed a whole page's editions (1,488) in one call and got back exactly 1,000 rows:
// 82 of 144 runs over three days logged editions_with_fmv = 1000, ~460 priced editions
// read as "no FMV", and whole distributions fell into nodes_no_fmv_coverage (no EV row).
// The same one-shot shape was live in compute-golazos-pack-ev, compute-topshot-pack-ev
// and app/api/wallet-cost-basis.
//
// The property: every call site passes a SLICED id list (the function returns at most one
// row per id, so a <=1000-id slice cannot reach the cap) — or is on the suppression list
// below with the reason its list is bounded. Tree walk, not a curated list of files.

const ROOTS = ["app", "lib", "supabase/functions"]

// file (repo-relative) -> why its p_edition_ids cannot exceed 1000
const BOUNDED: Record<string, string> = {
  "lib/pack-dist/fetchers.ts": "ids come from a pack_drop_pool read with .limit(50)",
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

const root = process.cwd()
const sites: Array<{ file: string; arg: string }> = []
for (const r of ROOTS) {
  for (const f of walk(path.join(root, r))) {
    const src = readFileSync(f, "utf8")
    const re = /rpc\(\s*["']get_fmv_for_editions["'][\s\S]{0,300}?p_edition_ids\s*:\s*([^,\n}]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) sites.push({ file: path.relative(root, f).split(path.sep).join("/"), arg: m[1].trim() })
  }
}

describe("get_fmv_for_editions callers stay under PostgREST max-rows", () => {
  it("finds the known call sites (the walk is not silently empty)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(5)
  })

  for (const s of sites) {
    it(`${s.file} passes a sliced (<=1000) id list`, () => {
      if (BOUNDED[s.file]) return
      expect(
        /\.slice\(/.test(s.arg),
        `${s.file} passes p_edition_ids: ${s.arg} unsliced — PostgREST returns at most 1000 rows ` +
          `and drops the rest silently. Chunk it (see compute-allday-pack-ev FMV_ID_CHUNK).`,
      ).toBe(true)
    })
  }

  it("every suppression still names a real call site", () => {
    for (const f of Object.keys(BOUNDED)) expect(sites.some((s) => s.file === f)).toBe(true)
  })
})
