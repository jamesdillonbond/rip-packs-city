/**
 * /api/og/trophy-challenge/<slug> — the TROPHY CHALLENGE card (1200×630 PNG),
 * 2026-11-07. Trevor: "trophy challenges like this should have their own
 * special link preview". The board page (/trophy-challenges/<slug>) and a
 * crawler following the dashboard deep link (proxy.ts) both unfurl as this.
 *
 * Reads the same anon RPC as the public board (`get_trophy_challenge_entries`),
 * so the card cannot show an entry the board would not. Draws: the challenge's
 * name and tagline, the entry count, and one piece from each of the first six
 * entries with its collector's handle.
 *
 * ⚠ Served through lib/og/card-store (a cold render is seconds; a crawler waits
 * less). Only a card with every picture present AND the read answered is
 * marked full and stored. ⚠ A failed read draws the neutral fallback — never
 * "0 entries" (a count we did not read is not zero). An unknown slug is the
 * fallback too: no card names a challenge that does not exist.
 */

import { ImageResponse } from "next/og"
import { NextRequest, after } from "next/server"
import { supabase as supabaseAnon } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"
import { ogImageDataUriSlots } from "@/lib/og/img-data"
import { brandFonts, brandFamilies, OG_CACHE_HEADERS, ogCacheHeaders, type OgFont } from "@/lib/og/brand-fonts"
import { fullCardHeaders, ogCardKey, serveStoredCard } from "@/lib/og/card-store"
import { cleanCardToken } from "@/lib/og/card-url"
import { hiResThumb, tierAccent } from "@/lib/trophy/slab-style"
import { isChallengeSlug } from "@/lib/trophy/challenge-link"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const RED = "#E03A2F" // brand-exception: OG images cannot read CSS custom properties

type Entry = { username: string; slab: Record<string, unknown> | null }
export type ChallengeCardData =
  | { kind: "ok"; title: string; tagline: string | null; entryCount: number; entries: Entry[] }
  | { kind: "missing" }
  | { kind: "failed" }

/** Pure: the card's data out of the board RPC's answer. */
export function challengeCardData(raw: unknown): ChallengeCardData {
  if (raw == null) return { kind: "missing" }
  const d = raw as { challenge?: any; entries?: unknown; entry_count?: unknown }
  const title = typeof d.challenge?.title === "string" ? d.challenge.title.trim() : ""
  if (!title) return { kind: "failed" }
  const list = Array.isArray(d.entries) ? (d.entries as any[]) : []
  const entryCount = typeof d.entry_count === "number" ? d.entry_count : list.length
  const entries: Entry[] = list.slice(0, 6).map((e) => {
    const slabs = (Array.isArray(e?.slabs) ? e.slabs : []).filter((s: any) => s?.thumbnail_url)
    slabs.sort((a: any, b: any) => (a.slot ?? 9) - (b.slot ?? 9))
    return { username: String(e?.username ?? ""), slab: slabs[0] ?? null }
  })
  return { kind: "ok", title, tagline: typeof d.challenge?.tagline === "string" ? d.challenge.tagline : null, entryCount, entries }
}

/** The line under the title. Never a zero we did not read; zero we DID read invites. */
export function entryLine(n: number): string {
  if (n <= 0) return "No entries yet — be the first"
  return `${n} collector${n === 1 ? "" : "s"} entered`
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
        <div style={{ display: "flex", gap: 12, fontSize: 52, fontWeight: 900, letterSpacing: 6 }}>
          <span style={{ color: "#fff" }}>TROPHY</span>
          <span style={{ color: RED }}>CHALLENGE</span>
        </div>
        <div style={{ display: "flex", color: "rgba(255,255,255,0.5)", fontSize: 18, letterSpacing: 2 }}>rippackscity.com</div>
      </div>
    ),
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: OG_CACHE_HEADERS },
  )
}

export async function renderChallengeCard(slug: string): Promise<Response> {
  const fonts = await brandFonts()
  const fam = brandFamilies(fonts)
  try {
    const { data, error } = await boundedRead(
      (supabaseAnon as any).rpc("get_trophy_challenge_entries", { p_slug: slug, p_limit: 6 }),
      "og/trophy-challenge/get_trophy_challenge_entries",
    )
    if (error) return renderFallback(fonts, fam.display)
    const card = challengeCardData(data)
    if (card.kind !== "ok") return renderFallback(fonts, fam.display)

    const withArt = card.entries.filter((e) => e.slab)
    const uris = await ogImageDataUriSlots(withArt.map((e) => hiResThumb(e.slab!.thumbnail_url as string) ?? null))
    const artless = uris.filter((u) => !u).length
    const n = withArt.length
    const w = n >= 6 ? 168 : n === 5 ? 190 : n === 4 ? 220 : 250
    const h = Math.round(w * 1.3)

    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            padding: "44px 48px 36px",
            background: "linear-gradient(135deg, #080808 0%, #14100f 55%, #1a0d0b 100%)",
            fontFamily: fam.display,
            color: "#fff",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ display: "flex", flexDirection: "column", maxWidth: 820 }}>
              <div style={{ display: "flex", color: RED, fontSize: 20, letterSpacing: 6, fontWeight: 900 }}>
                TROPHY CASE CHALLENGE
              </div>
              <div style={{ display: "flex", fontSize: 84, fontWeight: 900, letterSpacing: 3, lineHeight: 1, marginTop: 8 }}>
                {card.title.toUpperCase()}
              </div>
              {card.tagline ? (
                <div style={{ display: "flex", fontSize: 26, color: "rgba(255,255,255,0.75)", marginTop: 10, fontFamily: fam.mono }}>
                  {card.tagline.slice(0, 80)}
                </div>
              ) : null}
            </div>
            <div
              style={{
                display: "flex",
                padding: "10px 18px",
                borderRadius: 999,
                border: `2px solid ${RED}`,
                fontSize: 22,
                fontWeight: 900,
                letterSpacing: 3,
              }}
            >
              {entryLine(card.entryCount).toUpperCase()}
            </div>
          </div>

          <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", gap: 14, marginTop: 18 }}>
            {n > 0 ? (
              withArt.map((e, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      display: "flex",
                      width: w,
                      height: h,
                      borderRadius: 12,
                      overflow: "hidden",
                      border: `2px solid ${tierAccent((e.slab!.tier as string | null) ?? null)}`,
                      background: "#111",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {uris[i] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={uris[i]!} alt={`@${e.username}'s piece`} width={w} height={h} style={{ objectFit: "cover" }} />
                    ) : (
                      <div style={{ display: "flex", color: "rgba(255,255,255,0.4)", fontSize: 16, fontFamily: fam.mono }}>
                        ART UNAVAILABLE
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", fontSize: 18, fontFamily: fam.mono, color: "rgba(255,255,255,0.8)" }}>
                    @{e.username.slice(0, 16)}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ display: "flex", fontSize: 34, color: "rgba(255,255,255,0.6)", letterSpacing: 2 }}>
                SHOW OFF YOUR SIX — ENTER ON RIP PACKS CITY
              </div>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, fontFamily: fam.mono, color: "rgba(255,255,255,0.5)" }}>
            <div style={{ display: "flex" }}>rippackscity.com/trophy-challenges/{slug}</div>
            <div style={{ display: "flex", color: RED }}>RIP PACKS CITY</div>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        ...(fonts ? { fonts } : {}),
        // Stored only with every picture present (lib/og/card-store).
        headers: { ...ogCacheHeaders(artless > 0), ...fullCardHeaders(artless === 0) },
      },
    )
  } catch {
    return renderFallback(fonts, fam.display)
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const slug = decodeURIComponent((await ctx.params).slug ?? "").trim().toLowerCase()
  if (!isChallengeSlug(slug)) {
    const fonts = await brandFonts()
    return renderFallback(fonts, brandFamilies(fonts).display)
  }
  return serveStoredCard({
    key: ogCardKey("challenge", slug, null, cleanCardToken(req.nextUrl?.searchParams.get("s"))),
    render: () => renderChallengeCard(slug),
    fallback: async () => {
      const fonts = await brandFonts()
      return renderFallback(fonts, brandFamilies(fonts).display)
    },
    waitUntil: (p) => after(p),
  })
}
