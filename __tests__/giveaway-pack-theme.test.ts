import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { DEFAULT_PACK_THEME, PACK_THEMES, PACK_THEME_LABELS, isPackTheme, packTheme } from "@/lib/giveaways/pack-theme"

// The per-drop pack design (2026-11-10). One list (PACK_THEMES) is repeated in two places
// that cannot import it: the database CHECK and the stylesheet. A theme present in one and
// missing from another either refuses the admin's pick or silently draws the classic pack,
// so both copies are pinned here. "classic" must stay the look that existed before themes:
// it sets no variable at all (Trevor: "leave the dame time pack art as is").

const ROOT = path.resolve(__dirname, "..")

function themeMigration(): string {
  const dir = path.join(ROOT, "supabase/migrations")
  const files = readdirSync(dir).filter((f) => f.endsWith("_audit_20261110_giveaway_drop_pack_theme.sql"))
  expect(files).toHaveLength(1)
  return readFileSync(path.join(dir, files[0]), "utf8")
}

describe("giveaway pack themes", () => {
  it("the database CHECK lists exactly PACK_THEMES", () => {
    const sql = themeMigration()
    const m = sql.match(/CHECK \(pack_theme IN \(([^)]*)\)\)/)
    expect(m).not.toBeNull()
    const inDb = (m as RegExpMatchArray)[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""))
    expect(inDb.slice().sort()).toEqual([...PACK_THEMES].sort())
    expect(sql).toContain(`pack_theme text NOT NULL DEFAULT '${DEFAULT_PACK_THEME}'`)
  })

  it("existing drops keep a silent opening and new drops default to sound: false first, then true", () => {
    const sql = themeMigration()
    const added = sql.indexOf("ADD COLUMN IF NOT EXISTS opening_sound boolean NOT NULL DEFAULT false")
    const flipped = sql.indexOf("ALTER COLUMN opening_sound SET DEFAULT true")
    expect(added).toBeGreaterThan(-1)
    expect(flipped).toBeGreaterThan(added)
  })

  it("the stylesheet has one rule per non-classic theme, and none for classic", () => {
    const css = readFileSync(path.join(ROOT, "app/rpc-tokens.css"), "utf8")
    const inCss = [...css.matchAll(/\[data-pack-theme="([a-z]+)"\]\s*\{([^}]*)\}/g)].map((m) => ({ name: m[1], body: m[2] }))
    expect(inCss.map((r) => r.name).sort()).toEqual(PACK_THEMES.filter((t) => t !== "classic").sort())
    for (const r of inCss) {
      expect(r.body).toContain("--gw-pack:")
      expect(r.body).toContain("--gw-pack-glow:")
    }
    // classic = the fallback inside every use, which is the brand red token
    expect(css).toContain("var(--gw-pack, var(--rpc-red))")
    expect(css).toContain("var(--gw-pack-glow, var(--rpc-red))")
  })

  it("every theme has a label, and an unknown or missing value is the classic pack", () => {
    expect(Object.keys(PACK_THEME_LABELS).sort()).toEqual([...PACK_THEMES].sort())
    expect(DEFAULT_PACK_THEME).toBe("classic")
    expect(isPackTheme("gold")).toBe(true)
    for (const bad of ["neon", "", "Gold", null, undefined, 3]) {
      expect(isPackTheme(bad)).toBe(false)
      expect(packTheme(bad)).toBe("classic")
    }
    expect(packTheme("royal")).toBe("royal")
  })
})
