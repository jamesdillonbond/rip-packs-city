// 2026-11-17: rpc_main_tree_watch() (pg_cron, every 10 min) pages CRITICAL when any of its sentinel files
// 404s on `main` — that is how a commit deleting the tree (2e021e372, 9,617 files) gets seen. The flip side:
// renaming or moving a sentinel file in an ordinary change would page too. This test catches that in CI,
// before the push: every path in the NEWEST migration that defines the function must exist in this checkout.
//
// Derivation: the path list is read from the migration, never restated here, so a sentinel added there is
// checked here automatically. A planted defect (a path that does not exist) is asserted to be detected.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(__dirname, "..")
const migDir = join(root, "supabase", "migrations")

function newestWatchMigration(): string {
  const files = readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => /CREATE OR REPLACE FUNCTION public\.rpc_main_tree_watch\(\)/.test(readFileSync(join(migDir, f), "utf8")))
  expect(files.length).toBeGreaterThan(0)
  return readFileSync(join(migDir, files[files.length - 1]), "utf8")
}

function sentinelPaths(sql: string): string[] {
  const m = sql.match(/v_paths\s+constant\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\];/)
  expect(m).not.toBeNull()
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

function missing(paths: string[]): string[] {
  return paths.filter((p) => !existsSync(join(root, p)))
}

describe("main-tree watch sentinels", () => {
  it("reads a non-trivial sentinel list from the migration", () => {
    const paths = sentinelPaths(newestWatchMigration())
    expect(paths.length).toBeGreaterThanOrEqual(5)
    expect(paths).toContain("package.json")
  })

  it("every sentinel file exists, so an ordinary rename cannot page CRITICAL", () => {
    expect(missing(sentinelPaths(newestWatchMigration()))).toEqual([])
  })

  it("detects a planted sentinel that does not exist", () => {
    const planted = "    'package.json', 'no/such/sentinel-file.txt'\n"
    const sql = `v_paths constant text[] := ARRAY[\n${planted}  ];`
    expect(missing(sentinelPaths(sql))).toEqual(["no/such/sentinel-file.txt"])
  })
})
