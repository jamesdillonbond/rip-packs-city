import { describe, it, expect, vi } from "vitest"

// /api/og/giveaway/<slug> — the giveaway link preview (2026-11-10).
const h = vi.hoisted(() => ({ drop: null as unknown, pool: [] as unknown[], dropErr: null as unknown, poolErr: null as unknown }))
vi.mock("@/lib/supabase", () => {
  const q = (table: string) => {
    const self: any = {
      select: () => self, eq: () => self, order: () => self, limit: () => self,
      maybeSingle: () => Promise.resolve({ data: h.drop, error: h.dropErr }),
      then: (r: any, j: any) => Promise.resolve({ data: table === "giveaway_pack_moments" ? h.pool : null, error: h.poolErr }).then(r, j),
    }
    return self
  }
  return { supabaseAdmin: { from: q } }
})
vi.mock("@/lib/og/img-data", () => ({ ogImageDataUriSlots: async (u: unknown[]) => u.map(() => null) }))

import { giveawayCardData, packLine, seriesSetLabel } from "@/app/api/og/giveaway/[slug]/route"

const DROP = { id: "d", title: "Dame Time Challenge Reward Pack", status: "open", pack_count: 27, moments_per_pack: 2, eligible_challenge_id: "c" }
const P = (id: string, set: string, fmv: number) => ({ moment_id: id, player_name: "Damian Lillard", set_name: set, tier: "COMMON", fmv_usd: fmv })

describe("giveaway link preview", () => {
  it("shows the best piece of each set, best first, at most five; one player names the Moments", () => {
    const d = giveawayCardData(DROP, [P("1", "Base Set", 0.24), P("2", "Run It Back: Origins", 15.5), P("3", "Base Set", 1), P("4", "Archive Set", 0.72), P("5", "Metallic Gold LE", 6), P("6", "2021 NBA Playoffs", 1.45), P("7", "Spotlight Series", 0.21)])
    expect(d.kind).toBe("ok")
    if (d.kind !== "ok") return
    expect(d.showcase.map((p) => p.set_name)).toEqual(["Run It Back: Origins", "Metallic Gold LE", "2021 NBA Playoffs", "Base Set", "Archive Set"])
    expect(d.showcase.find((p) => p.set_name === "Base Set")!.moment_id).toBe("3")
    expect(d.gated).toBe(true)
    expect(packLine(d)).toBe("27 packs · 2 Lillard Moments each")
  })

  it("a draft, a missing drop or a drop with no title is the neutral fallback — never a giveaway that may not exist", () => {
    expect(giveawayCardData(null, []).kind).toBe("fallback")
    expect(giveawayCardData({ ...DROP, status: "draft" }, []).kind).toBe("fallback")
    expect(giveawayCardData({ ...DROP, title: " " }, []).kind).toBe("fallback")
  })

  it("draws no 'packs left' count: the card states only what was fixed at seal time", () => {
    const d = giveawayCardData({ ...DROP, eligible_challenge_id: null }, [P("1", "Base Set", 1)])
    if (d.kind !== "ok") throw new Error("expected ok")
    expect(packLine(d)).not.toMatch(/left|remaining/i)
    expect(d.gated).toBe(false)
  })

  it("a recurring set carries its series (Trevor 11-10: 'S1 Base', 'S3 Metallic Gold LE'); a one-series set stays plain; on-chain 0 is Series 1", () => {
    expect(seriesSetLabel("Base Set", 0, true)).toBe("S1 Base Set")
    expect(seriesSetLabel("Metallic Gold LE", 4, true)).toBe("S3 Metallic Gold LE")
    expect(seriesSetLabel("Archive Set", 3, true)).toBe("Summer '21 Archive Set")
    expect(seriesSetLabel("Run It Back: Origins", 7, true)).toBe("'24-25 Run It Back: Origins")
    expect(seriesSetLabel("2021 NBA Playoffs", 2, false)).toBe("2021 NBA Playoffs")
    expect(seriesSetLabel("Base Set", null, true)).toBe("Base Set")
    expect(seriesSetLabel("Base Set", 99, true)).toBe("Base Set")
  })

  it("series-qualified labels split one set into its series for the showcase (S1 Base and S4 Base are different pieces)", () => {
    const labels = new Map([["k1", "S1 Base Set"], ["k2", "S4 Base Set"]])
    const d = giveawayCardData(DROP, [{ ...P("1", "Base Set", 1), edition_key: "k1" }, { ...P("2", "Base Set", 0.24), edition_key: "k2" }], labels)
    if (d.kind !== "ok") throw new Error("expected ok")
    expect(d.showcase.map((p) => p.label)).toEqual(["S1 Base Set", "S4 Base Set"])
  })
})
