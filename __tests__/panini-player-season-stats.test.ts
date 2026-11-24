import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 2026-11-23 Panini parity pass 2: Panini player pages show ESPN Season Stats like Top Shot / All Day / Candy, read
// through panini_espn_crosswalk (get_panini_player_season_stats, 20261124030628) by the slugs Recent Games uses.
const page = readFileSync(join(process.cwd(), "app/(collections)/[collection]/player/[slug]/page.tsx"), "utf8")
const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261124030628_audit_20261123_panini_player_season_stats.sql"), "utf8")

describe("Panini season stats", () => {
  it("the Panini arm reads its own function by the page's slugs, before the identity-keyed collections", () => {
    const i = page.indexOf('if (collectionSlug === "panini_blockchain") {')
    const j = page.indexOf("if (!SEASON_STATS_COLLECTIONS.has(collectionSlug)) return null")
    expect(i).toBeGreaterThan(0)
    expect(i).toBeLessThan(j)
    expect(page).toContain('sectionRowResult<SeasonStatsResult>("player season stats", "get_panini_player_season_stats", { p_slugs: slugs, p_seasons: 3 })')
    expect(page).toContain("<SeasonStatsSection playerId={detail.id} playerName={detail.name} slug={slug} collectionSlug={coll.dbSlug} />")
  })
  it("two athletes behind one key, or a sport with no season lines, is NULL (no feed) — never another player's stats", () => {
    expect(sql).toMatch(/IF v_n IS DISTINCT FROM 1 THEN\s+RETURN NULL;/)
    expect(sql).toMatch(/v_league := CASE v_sport WHEN 'basketball' THEN 'nba' WHEN 'football' THEN 'nfl' WHEN 'baseball' THEN 'mlb' END;\s+IF v_league IS NULL THEN\s+RETURN NULL;/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_panini_player_season_stats\(text\[\], integer\) FROM PUBLIC, anon, authenticated/)
  })
})
