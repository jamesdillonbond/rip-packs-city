// /leagues — the coverage map (2026-11-26): every league and brand RPC tracks, and where its cards live.
//
// Panini and Candy each publish many leagues and brands, and the Flow collections are each one league's
// own product — so "does RPC have NBA?" has three answers (Top Shot, Panini) that no single section showed.
// One tile per league / brand, under "Leagues" and "Entertainment" (Trevor 11-26: no umbrella word; the
// code word "property" never renders). Data: the two publisher boards (lib/panini/properties.ts,
// lib/candy/properties.ts) — a failed read is named on the page, never rendered as "covers nothing".

import type { Metadata } from "next"
import { franchiseHubMetadata } from "@/lib/seo"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import LeagueMap from "@/components/LeagueMap"
import { buildLeagueMap } from "@/lib/league-map"
import { fetchPaniniPropertyBoard } from "@/lib/panini/properties"
import { fetchCandyPropertyBoard } from "@/lib/candy/properties"

export const revalidate = 1800

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = franchiseHubMetadata({
  name: "Leagues and Brands — everything Rip Packs City covers",
  description:
    "Every league and brand Rip Packs City tracks, and where its digital collectibles live: NBA, WNBA, NFL, MLB, LaLiga, UFC, FIFA World Cup, WWE, NASCAR, DC, Disney and more across NBA Top Shot, NFL All Day, Panini, Candy and Disney Pinnacle.",
  canonical: `${SITE}/leagues`,
})

export default async function LeaguesPage() {
  const [panini, candy] = await Promise.all([fetchPaniniPropertyBoard(), fetchCandyPropertyBoard()])
  const map = buildLeagueMap({
    panini: panini.ok ? panini.board.properties : null,
    candy: candy.ok ? candy.board.properties : null,
  })
  return (
    <div>
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Leagues and brands" }]} />
      <header style={{ marginTop: 8, marginBottom: 6 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 28, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0 }}>
          Leagues and brands
        </h1>
        <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 720, margin: "8px 0 0", lineHeight: 1.5 }}>
          Everything Rip Packs City covers, and where each one&rsquo;s cards live. Some leagues have a collection of their own; Panini and Candy each publish many.
        </p>
      </header>
      <LeagueMap leagues={map.leagues} entertainment={map.entertainment} failed={map.failed} />
    </div>
  )
}
