/**
 * /api/og/giveaway/<slug> — the GIVEAWAY card (1200×630 PNG), 2026-11-10.
 * Trevor, posting the Dame Time reward packs on X: "This needs a link preview".
 * The claim page (/giveaways/<slug>) unfurls as this.
 *
 * Draws the drop's title, who it is for (a challenge-gated drop says so), the
 * pack shape (N packs × M Moments — fixed when the drop was sealed, so a cached
 * card never goes stale), and the art of the pool's best piece from each of up
 * to five different sets, best first.
 *
 * ⚠ It does NOT draw "packs left": X keeps a card for days, and a count read at
 * post time would be false an hour later. ⚠ A failed read, a draft or an
 * unknown slug draws the neutral fallback — never a giveaway that may not exist.
 */

import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"
import { ogImageDataUriSlots } from "@/lib/og/img-data"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS, ogCacheHeaders, type OgFont } from "@/lib/og/brand-fonts"
import { topShotMomentImage } from "@/lib/giveaways/reveal"
import { tierAccent } from "@/lib/trophy/slab-style"
import { readPoolExtras, seriesSetLabel, type MomentExtras } from "@/lib/giveaways/pool-extras"
import { badgeGlyphDataUri, specialGlyphDataUri, GOLD_HEX, type SpecialCat } from "@/lib/badges/glyphs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const RED = "#E03A2F" // brand-exception: OG images cannot read CSS custom properties
const SLUG = /^[a-z0-9][a-z0-9-]{2,59}$/

type PoolPiece = { moment_id: string; set_name: string | null; label: string | null; tier: string | null; fmv_usd: number | null; badges: string[]; special: SpecialCat[] }

export { seriesSetLabel }
export type GiveawayCardData =
  | { kind: "ok"; title: string; gated: boolean; packCount: number; perPack: number; player: string | null; showcase: PoolPiece[] }
  | { kind: "fallback" }

/** Pure: the card's data out of the drop row and its pool. */
export function giveawayCardData(
  drop: Record<string, unknown> | null,
  pool: Record<string, unknown>[],
  /** moment_id → extras (lib/giveaways/pool-extras.ts); absent = plain set name, no badges */
  extras: Map<string, MomentExtras> = new Map(),
): GiveawayCardData {
  if (!drop) return { kind: "fallback" }
  const status = String(drop.status ?? "")
  if (!["sealed", "open", "closed"].includes(status)) return { kind: "fallback" }
  const title = typeof drop.title === "string" ? drop.title.trim() : ""
  const packCount = Number(drop.pack_count)
  const perPack = Number(drop.moments_per_pack)
  if (!title || !Number.isFinite(packCount) || packCount <= 0 || !Number.isFinite(perPack) || perPack <= 0) return { kind: "fallback" }
  const pieces: PoolPiece[] = pool
    .filter((r) => /^\d+$/.test(String(r.moment_id ?? "")))
    .map((r) => ({
      moment_id: String(r.moment_id),
      set_name: typeof r.set_name === "string" ? r.set_name : null,
      label: extras.get(String(r.moment_id))?.set_label ?? (typeof r.set_name === "string" ? r.set_name : null),
      badges: extras.get(String(r.moment_id))?.badges ?? [],
      special: extras.get(String(r.moment_id))?.special_serial ?? [],
      tier: typeof r.tier === "string" ? r.tier : null,
      fmv_usd: r.fmv_usd == null ? null : Number(r.fmv_usd),
    }))
    .sort((a, b) => (b.fmv_usd ?? -1) - (a.fmv_usd ?? -1))
  const seen = new Set<string>()
  const showcase: PoolPiece[] = []
  for (const p of pieces) {
    const key = p.label ?? `#${p.moment_id}`
    if (seen.has(key)) continue
    seen.add(key)
    showcase.push(p)
    if (showcase.length === 5) break
  }
  const players = new Set(pool.map((r) => (typeof r.player_name === "string" ? r.player_name : "")).filter(Boolean))
  return {
    kind: "ok",
    title,
    gated: drop.eligible_challenge_id != null,
    packCount,
    perPack,
    player: players.size === 1 ? [...players][0] : null,
    showcase,
  }
}

/** The line under the title — the pack shape, fixed at seal time. */
export function packLine(d: { packCount: number; perPack: number; player: string | null }): string {
  const what = d.player ? `${d.player.split(" ").slice(-1)[0]} Moments` : "Moments"
  return `${d.packCount} packs · ${d.perPack} ${d.perPack === 1 ? what.replace(/s$/, "") : what} each`
}

function renderFallback(fonts?: OgFont[], display = "sans-serif") {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          background: "linear-gradient(135deg, #080808 0%, #111116 60%, #0d0d12 100%)",
          fontFamily: display,
        }}
      >
        <div style={{ display: "flex", gap: 12, fontSize: 56, fontWeight: 900, letterSpacing: 6 }}>
          <span style={{ color: "#fff" }}>PACK</span>
          <span style={{ color: RED }}>GIVEAWAY</span>
        </div>
        <div style={{ display: "flex", color: "rgba(255,255,255,0.5)", fontSize: 18, letterSpacing: 2 }}>rippackscity.com</div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS },
  )
}

export async function renderGiveawayCard(slug: string): Promise<Response> {
  const fonts = await brandFonts()
  const fam = brandFamilies(fonts)
  try {
    const dropRes = await boundedRead(
      supabaseAdmin
        .from("giveaway_drops")
        .select("id, title, status, pack_count, moments_per_pack, eligible_challenge_id, collection_id")
        .eq("slug", slug)
        .maybeSingle(),
      "og/giveaway/drop",
    )
    if (dropRes.error || !dropRes.data) return renderFallback(fonts, fam.display)
    const poolRes = await boundedRead(
      supabaseAdmin
        .from("giveaway_pack_moments")
        .select("moment_id, edition_key, player_name, set_name, tier, fmv_usd, serial_number")
        .eq("drop_id", (dropRes.data as { id: string }).id)
        .order("moment_id", { ascending: true })
        .limit(1000),
      "og/giveaway/pool",
    )
    if (poolRes.error) return renderFallback(fonts, fam.display)
    const poolRows = (poolRes.data ?? []) as Record<string, unknown>[]
    const extras = await readPoolExtras(
      supabaseAdmin,
      String((dropRes.data as { collection_id?: unknown }).collection_id ?? ""),
      poolRows.map((r) => ({
        moment_id: String(r.moment_id ?? ""),
        edition_key: typeof r.edition_key === "string" ? r.edition_key : null,
        set_name: typeof r.set_name === "string" ? r.set_name : null,
        serial_number: r.serial_number == null ? null : Number(r.serial_number),
      })),
    )
    const card = giveawayCardData(dropRes.data as Record<string, unknown>, poolRows, extras)
    if (card.kind !== "ok") return renderFallback(fonts, fam.display)

    const uris = await ogImageDataUriSlots(card.showcase.map((p) => topShotMomentImage(p.moment_id, 600)))
    const artless = uris.filter((u) => !u).length
    const n = card.showcase.length
    const w = n >= 5 ? 196 : n === 4 ? 230 : n === 3 ? 270 : 300
    const h = Math.round(w * 1.0)

    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            padding: "44px 52px 34px",
            background: "linear-gradient(135deg, #080808 0%, #16100f 55%, #220d0a 100%)",
            fontFamily: fam.display,
            color: "#fff",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", color: RED, fontSize: 21, letterSpacing: 6, fontWeight: 900 }}>
              {card.gated ? "FREE REWARD PACKS · FOR CHALLENGE FINISHERS" : "FREE PACK GIVEAWAY"}
            </div>
            <div style={{ display: "flex", fontSize: card.title.length > 34 ? 52 : card.title.length > 24 ? 64 : 80, fontWeight: 900, letterSpacing: 2, lineHeight: 1.02, marginTop: 10 }}>
              {card.title.toUpperCase()}
            </div>
            <div style={{ display: "flex", marginTop: 14 }}>
              <div
                style={{
                  display: "flex",
                  padding: "8px 18px",
                  borderRadius: 999,
                  border: `2px solid ${RED}`,
                  fontSize: 22,
                  fontWeight: 900,
                  letterSpacing: 3,
                }}
              >
                {packLine(card).toUpperCase()}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flex: 1, alignItems: "flex-start", justifyContent: "center", gap: 16, marginTop: 34 }}>
            {card.showcase.map((p, i) => (
              <div key={p.moment_id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    display: "flex",
                    width: w,
                    height: h,
                    borderRadius: 14,
                    overflow: "hidden",
                    border: `2px solid ${i === 0 ? RED : tierAccent(p.tier)}`,
                    background: "#0b0b0b",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {uris[i] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={uris[i]!} alt={p.set_name ?? "Moment"} width={w} height={h} style={{ objectFit: "cover" }} />
                  ) : (
                    <div style={{ display: "flex", color: "rgba(255,255,255,0.4)", fontSize: 16, fontFamily: fam.mono }}>ART UNAVAILABLE</div>
                  )}
                </div>
                <div style={{ display: "flex", fontSize: (p.label ?? "").length > 22 ? 15 : 18, fontFamily: fam.mono, color: i === 0 ? RED : "rgba(255,255,255,0.8)" }}>
                  {(p.label ?? "").slice(0, 30)}
                </div>
                {p.special.length + p.badges.length > 0 ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    {p.special.map((c) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={c} src={specialGlyphDataUri(c)} alt={c} width={26} height={26} />
                    ))}
                    {p.badges.slice(0, 4).map((t) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={t} src={badgeGlyphDataUri(t, GOLD_HEX)} alt={t} width={26} height={26} />
                    ))}
                  </div>
                ) : null}
                {p.badges.length > 0 ? (
                  <div style={{ display: "flex", width: w + 10, justifyContent: "center", textAlign: "center", fontSize: 12, lineHeight: 1.3, fontFamily: fam.mono, color: GOLD_HEX }}>
                    {p.badges.slice(0, 4).join(" · ").toUpperCase()}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, fontFamily: fam.mono, color: "rgba(255,255,255,0.55)" }}>
            <div style={{ display: "flex" }}>Delivered straight to your Top Shot account</div>
            <div style={{ display: "flex", color: RED }}>RIPPACKSCITY.COM</div>
          </div>
        </div>
      ),
      { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: ogCacheHeaders(artless > 0) },
    )
  } catch {
    return renderFallback(fonts, fam.display)
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const slug = decodeURIComponent((await ctx.params).slug ?? "").trim().toLowerCase()
  if (!SLUG.test(slug)) {
    const fonts = await brandFonts()
    return renderFallback(fonts, brandFamilies(fonts).display)
  }
  return renderGiveawayCard(slug)
}
