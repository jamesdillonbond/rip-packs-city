/**
 * app/api/og/share/route.tsx
 *
 * OG card for /share/<wallet>, served as a route handler (Node runtime since 2026-11-16).
 *
 * The previous app/share/[wallet]/opengraph-image.tsx (the Next metadata
 * file convention) rendered a 0-byte PNG on the edge runtime and threw a 500 on
 * the node runtime in this Next 16 setup — the failure is in the metadata-image
 * convention's lazy ImageResponse streaming, not the JSX (a try/catch around the
 * construction never fired). The identical ImageResponse renders reliably from a
 * route handler — exactly how every other OG image on the site is served
 * (/api/og/default and the lib/og entity cards). So /share now points its
 * openGraph.images at this route instead of the file convention.
 */
import { ImageResponse } from "next/og"
import { NextRequest } from "next/server"
import { brandFonts, brandFamilies, ogCacheHeaders } from "@/lib/og/brand-fonts"
import { ogFetch } from "@/lib/og/og-fetch"
import { shareWalletTotalUsd, walletTotalCaption, type HeldPacksTotal } from "@/lib/dashboard/held-packs"

// Node, not edge (2026-11-16): on edge the brand fonts come over HTTP from our own
// origin on every cold isolate — the first unfurl of a shared link measured
// 6.1–6.5 s, past where iMessage / WhatsApp / X give up on the image. On Node
// lib/og/brand-fonts reads them off the function's disk (traced in next.config.ts).
export const runtime = "nodejs"

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export async function GET(req: NextRequest) {
  // Brand typography + a long shared cache. `brandFonts` never rejects and
  // validates the bytes before satori sees them, so this cannot break the card.
  const fonts = await brandFonts();
  const fam = brandFamilies(fonts);

  const wallet = req.nextUrl.searchParams.get("wallet") || ""

  // ⚠ `fetched` answers "did the snapshot READ succeed", NOT "does this wallet
  // hold anything". It must be set INSIDE the `res.ok` branch.
  //
  // This card is the one a collector POSTS to show off their collection, and
  // before 2026-08-13 a failed read fell back to `totalFmv = 0` / `totalMoments
  // = 0` and published "$0.00 / 0 moments" — a false FINANCIAL claim about a
  // named person, baked into an edge-cached PNG and distributed on social. The
  // old comment called that "a branded shell", but zeros are not a shell, they
  // are a NUMBER, and a reader has no way to tell it from a real answer.
  //
  // A wallet that genuinely holds nothing is different and still renders $0.00 —
  // that is a true statement about an empty wallet.
  let fetched = false
  let totalFmv = 0
  let perCollection: Array<{ fmv?: number | null }> = []
  let totalMoments = 0
  let topPlayers: string[] = []

  // 2026-10-25: the card names the collector's @handle when one resolves (the
  // share page does the same) — a wallet address is not how collectors know each
  // other. Read in parallel with the snapshot through the same anon-public
  // endpoint the client resolver uses; any failure keeps the shortened address.
  // The name comes from OUR lookup, never from a query param, so a crafted URL
  // cannot put arbitrary text on an RPC-branded image.
  const handlePromise: Promise<string | null> = ogFetch(
    `${BASE_URL}/api/analytics/wallets/resolve-usernames?addrs=${encodeURIComponent(wallet)}`,
    { next: { revalidate: 3600 } },
  )
    .then(async (r) => {
      if (!r.ok) return null
      const j = (await r.json()) as { usernames?: Record<string, string> }
      const u = j?.usernames ?? {}
      const hit = u[wallet] ?? u[wallet.toLowerCase()] ?? null
      return typeof hit === "string" && hit.trim() ? hit.trim().replace(/^@/, "") : null
    })
    .catch(() => null)

  try {
    const res = await ogFetch(`${BASE_URL}/api/collection-snapshot?wallet=${encodeURIComponent(wallet)}`, {
      next: { revalidate: 300 },
    })
    if (res.ok) {
      const data = await res.json()
      // 2026-11-14: a 200 with `indexed: false` (never walked) or `null` (couldn't tell) is NOT a
      // measurement of an empty wallet — the share page itself shows "Analyzing…" there. The card
      // drew "$0.00 · 0 moments" and cached it for hours. Withhold unless the wallet is known walked
      // (an older payload without the field keeps the old behaviour).
      const knownWalked = data?.indexed === undefined || data?.indexed === true
      if (knownWalked) fetched = true
      totalFmv = data.totalFmv ?? 0
      perCollection = Array.isArray(data.perCollection) ? data.perCollection : []
      totalMoments = data.totalMoments ?? 0
      topPlayers = (data.topMoments ?? []).slice(0, 3).map((m: { playerName: string }) => m.playerName)
    }
  } catch {
    /* fetched stays false — the card withholds the figures rather than zeroing them */
  }
  const handle = await handlePromise

  // 2026-11-22 (Trevor: one number for everything in the wallet, UFC included): the card shows
  // the share page's single figure — every collection's FMV + sealed packs at capped low ask —
  // and Total Assets (moments + sealed packs). A failed pack read is said on the card, never
  // silently left out of a number a collector posts.
  let packs: HeldPacksTotal | null = null
  let packsFailed = false
  if (/^0x[0-9a-fA-F]{16}$/.test(wallet)) {
    try {
      const pr = await ogFetch(`${BASE_URL}/api/public/wallet-packs?wallet=${encodeURIComponent(wallet)}`, {
        next: { revalidate: 600 },
      })
      if (!pr.ok) throw new Error(String(pr.status))
      const d = await pr.json()
      packs = { held: Number(d?.held) || 0, listed: Number(d?.listed) || 0, lowAskUsd: Number(d?.low_ask_usd) || 0, unpriced: Number(d?.unpriced) || 0, walletsFailed: 0 }
    } catch {
      packsFailed = true
    }
  }
  const walletValue = shareWalletTotalUsd(perCollection, totalFmv, packs, packsFailed)
  const valueNote = walletTotalCaption(packs, packsFailed)
  const totalAssets = Number(totalMoments) + (!packsFailed && packs ? packs.held : 0)

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(180deg, #0A0A0A 0%, #111111 100%)",
          padding: "48px 56px",
          fontFamily: fam.display,
        }}
      >
        {/* Top row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div style={{ fontSize: 36, fontWeight: 900, color: "#E03A2F", letterSpacing: "0.08em", display: "flex" }}>
            RIP PACKS CITY
          </div>
          <div style={{ fontSize: 18, color: "#666", fontFamily: fam.mono, display: "flex" }}>
            {handle ? `@${handle}` : wallet.length > 18 ? wallet.slice(0, 8) + "..." + wallet.slice(-6) : wallet}
          </div>
        </div>

        {/* Center */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          {/* ⚠ An explicit column div, not a fragment: satori laid a fragment's
              children out as a ROW, so the live card printed "COLLECTION FMV",
              the figure and "N moments" side by side (seen 2026-10-25). */}
          {fetched ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
              <div style={{ fontSize: 20, color: "#666", letterSpacing: "0.15em", textTransform: "uppercase", display: "flex" }}>
                COLLECTION FMV
              </div>
              <div style={{ fontSize: 80, fontWeight: 900, color: "#E03A2F", display: "flex" }}>
                ${walletValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              {valueNote && (
                <div style={{ fontSize: 18, color: "#666", fontFamily: fam.mono, display: "flex" }}>
                  {valueNote}
                </div>
              )}
              <div style={{ fontSize: 22, color: "#888", display: "flex" }}>
                {totalAssets.toLocaleString("en-US")} asset{totalAssets === 1 ? "" : "s"}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
              <div style={{ fontSize: 20, color: "#666", letterSpacing: "0.15em", textTransform: "uppercase", display: "flex" }}>
                COLLECTION SNAPSHOT
              </div>
              <div style={{ fontSize: 28, color: "#888", display: "flex", textAlign: "center", maxWidth: 800 }}>
                Open the page for this wallet&apos;s current value
              </div>
            </div>
          )}
        </div>

        {/* Bottom */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {topPlayers.map((name, i) => (
              <div key={i} style={{ fontSize: 18, color: "#555", fontFamily: fam.mono, display: "flex" }}>
                {i + 1}. {name}
              </div>
            ))}
          </div>
          {/* 2026-10-11 (platform review M8): the card is the one a collector
              posts, and it ended in the bare domain — a reader had no idea what
              the site would do for THEM. One CTA line, true of every visitor
              (any wallet can be looked up without an account), in the card's
              own muted mono; no numbers, no superiority claim. */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <div style={{ fontSize: 18, color: "#666", fontFamily: fam.mono, display: "flex" }}>
              See what your collection is worth
            </div>
            <div style={{ fontSize: 16, color: "#444", fontFamily: fam.mono, letterSpacing: "0.1em", display: "flex" }}>
              rippackscity.com
            </div>
          </div>
        </div>
      </div>
    ),
    // A card whose read FAILED is cached for a minute, not an hour + a day of SWR (2026-11-04,
    // lib/og/brand-fonts.ts ogCacheHeaders): a cache-cold whale's snapshot can outrun the 10 s read (#228), and the figure-less card it got
    // then sat at the CDN for up to 25 h while the data was warm a minute later.
    { width: 1200, height: 630, ...(fonts ? { fonts } : {}), headers: ogCacheHeaders(!fetched) }
  )
}
