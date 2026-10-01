"use client"

// PaniniPackMarket — the Panini Packs body (standalone /panini-blockchain/packs
// and the Market tab's Packs sub-section, via PackMarketView). Reads
// /api/panini-pack-market, which serves Panini's native pack plane — two sealed
// WC Prizm products (Hobby, FOTL), none of it in the Flow `pack_distributions`
// board. 2026-09-27.
//
// Honesty rules this component keeps (see the route header for the why):
//   · "Typical pull" leads the EV block; the chase-inclusive mean is secondary
//   · a product whose market stats are older than the route's stale bound says so
//     beside the price, instead of reading as the live price
//   · a cost that is an AVERAGE SALE (no floor) is labelled as such
//   · each panel has three states — failed, empty, rows — and a failed read
//     renders as "couldn't load", never as "none"
//   · the listing-gated coverage disclosure always renders (the EV legs are priced
//     off FMV on an index that sees a card only once it has been listed)
//   · MULTI-PRODUCT (2026-09-28): a pack whose product the EV model does not price
//     (evModeled !== true — WNBA, NBA, NFL… as they are discovered) shows its market
//     stats and says EV is NOT MODELED; it never renders an EV figure, a "—" that
//     could read as "worthless", or the EV-legs table

import { useEffect, useState } from "react"
import { fetchJson } from "@/lib/analytics/fetch-json"
import PaniniCoverageNote from "@/components/collection/PaniniCoverageNote"
import type { PaniniCoverage } from "@/lib/panini/coverage"
import type { PaniniPackLabel } from "@/lib/panini/pack-market"
import MomentMedia from "@/components/MomentMedia"

export interface PaniniPackProduct {
  id: string
  packType: string
  label: string
  name: string | null
  /** Panini's product (collection) name, e.g. "2026 Panini NFT Prizm WNBA". */
  productName?: string | null
  sport?: string | null
  /** True only when the pack-EV model prices this pack's product (today: WC Prizm). */
  evModeled?: boolean
  imageUrl?: string | null
  labels: PaniniPackLabel[]
  cardsPerPack: number | null
  costUsd: number | null
  costBasis: "floor" | "avg_sale" | "primary" | null
  floorUsd: number | null
  avgSaleUsd: number | null
  recentSaleUsd: number | null
  topSaleUsd: number | null
  listedCount: number | null
  packsTotal: number | null
  packsRemaining: number | null
  rippedPct: number | null
  typicalEvUsd: number | null
  actualEvUsd: number | null
  netRipEdgeUsd: number | null
  legs: { silver: number | null; baseParallel: number | null; insert: number | null; fotlExclusive: number | null }
  modelNote: string | null
  updatedAt: string | null
  stale: boolean
}

export interface PaniniPackMarketResponse {
  products: PaniniPackProduct[]
  details_error: boolean
  history: { packId?: string; packType: string; observedAt: string | null; floorUsd: number | null; recentSaleUsd: number | null; avgSaleUsd: number | null; packsRemaining: number | null }[] | null
  history_error: boolean
  history_days: number
  stale_after_hours: number
  coverage: PaniniCoverage | null
  coverage_error: boolean
}

const mono = "var(--font-mono)"
const display = "var(--font-display)"

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2, minimumFractionDigits: n >= 100 ? 0 : 2 })
}

function signedUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return (n > 0 ? "+" : n < 0 ? "−" : "") + usd(Math.abs(n))
}

function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US")
}

/** Absolute PT date+time — the reader's clock never enters render. */
function ptStamp(iso: string | null): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) + " PT"
}

function Tile({ label, value, sub, lead }: { label: string; value: string; sub?: string; lead?: boolean }) {
  return (
    <div
      style={{
        background: "var(--rpc-surface)",
        border: `1px solid ${lead ? "var(--rpc-red-border)" : "var(--rpc-border)"}`,
        borderRadius: 8,
        padding: "12px 14px",
        minWidth: 140,
        flex: "1 1 140px",
      }}
    >
      <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>{label}</div>
      <div style={{ fontFamily: display, fontWeight: 800, fontSize: 22, color: "var(--rpc-text-primary)", marginTop: 4 }}>{value}</div>
      {sub ? <div style={{ fontFamily: mono, fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 2 }}>{sub}</div> : null}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: mono, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>{children}</div>
}

const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", fontFamily: mono, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)", borderBottom: "1px solid var(--rpc-border)" }
const td: React.CSSProperties = { padding: "6px 8px", fontFamily: mono, fontSize: 12, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle)" }

function ProductCard({ p, staleAfterHours }: { p: PaniniPackProduct; staleAfterHours: number }) {
  const costLabel = p.costBasis === "avg_sale" ? "Cost (avg sale — no floor)" : p.costBasis === "primary" ? "Panini drop price" : "Floor"
  const modeled = p.evModeled === true
  return (
    <section
      data-testid={`panini-pack-${p.id}`}
      data-ev-modeled={modeled ? "true" : "false"}
      style={{ marginTop: 20, padding: "16px 16px 12px", background: "var(--rpc-surface-raised, var(--rpc-surface))", border: "1px solid var(--rpc-border)", borderRadius: 10 }}
    >
      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        {p.imageUrl ? (
          <div style={{ width: 64, height: 64, borderRadius: 8, overflow: "hidden", flex: "0 0 auto" }}>
            <MomentMedia thumbnailUrl={p.imageUrl} alt={`${p.label} pack`} size={64} rounded={8} />
          </div>
        ) : null}
        <div>
          <h2 style={{ fontFamily: display, fontWeight: 800, fontSize: 18, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 4px" }}>
            {p.label} pack{p.cardsPerPack !== null ? ` · ${p.cardsPerPack} cards` : ""}
          </h2>
          {p.name ? <Note>{p.name}</Note> : p.productName ? <Note>{p.productName}</Note> : null}
        </div>
      </div>
      {p.stale ? (
        <div role="status" style={{ marginTop: 8, padding: "8px 12px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 6 }}>
          <Note>
            These market stats were last refreshed {ptStamp(p.updatedAt)} — more than {staleAfterHours} h ago — so the prices below may not be current.
          </Note>
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
        <Tile label={costLabel} value={usd(p.costUsd)} sub={p.recentSaleUsd !== null ? `recent sale ${usd(p.recentSaleUsd)}` : undefined} lead />
        {modeled ? (
          <>
            <Tile label="Typical pull" value={usd(p.typicalEvUsd)} sub="what the median pack holds" />
            <Tile label="EV (mean)" value={usd(p.actualEvUsd)} sub={p.netRipEdgeUsd !== null ? `${signedUsd(p.netRipEdgeUsd)} vs cost` : undefined} />
          </>
        ) : (
          <Tile label="Pack EV" value="Not modeled" sub="RPC doesn't price this product's cards yet" />
        )}
        <Tile
          label="Sealed"
          value={count(p.packsRemaining)}
          sub={p.packsTotal !== null ? `of ${count(p.packsTotal)}${p.rippedPct !== null ? ` · ${p.rippedPct}% ripped` : ""}` : undefined}
        />
      </div>

      <div style={{ overflowX: "auto", marginTop: 12 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 320 }}>
          <tbody>
            <tr><td style={td}>Average sale</td><td style={td}>{usd(p.avgSaleUsd)}</td></tr>
            <tr><td style={td}>Top sale</td><td style={td}>{usd(p.topSaleUsd)}</td></tr>
            <tr><td style={td}>Market listings (Panini&apos;s count)</td><td style={td}>{count(p.listedCount)}</td></tr>
            {modeled ? (
              <>
                <tr><td style={td}>EV legs — Base Silver</td><td style={td}>{usd(p.legs.silver)}</td></tr>
                <tr><td style={td}>EV legs — Base non-Silver parallel</td><td style={td}>{usd(p.legs.baseParallel)}</td></tr>
                <tr><td style={td}>EV legs — Insert</td><td style={td}>{usd(p.legs.insert)}</td></tr>
              </>
            ) : null}
            {modeled && p.packType === "fotl" ? (
              <tr><td style={td}>EV legs — FOTL-exclusive parallel</td><td style={td}>{usd(p.legs.fotlExclusive)}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {p.labels.length ? (
        <div style={{ marginTop: 12 }}>
          {p.labels.map((l) => (
            <div key={l.label} style={{ marginTop: 6 }}>
              <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>{l.label} (Panini)</div>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {l.lines.map((line) => (
                  <li key={line} style={{ fontFamily: mono, fontSize: 12, lineHeight: 1.5, color: "var(--rpc-text-secondary)" }}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ marginTop: 10 }}>
        <Note>Updated {ptStamp(p.updatedAt)}{modeled && p.modelNote ? ` · model ${p.modelNote.split(" · ")[0]}` : ""}</Note>
      </div>
    </section>
  )
}

/** "FOTL" alone is ambiguous once two products each have a FOTL pack — name the product when it isn't WC. */
function historyLabel(h: { packId?: string; packType: string }, products: PaniniPackProduct[]): string {
  const type = h.packType === "fotl" ? "FOTL" : h.packType === "hobby" ? "Hobby" : h.packType
  const prod = h.packId ? products.find((p) => p.id === h.packId) : undefined
  if (!prod || prod.evModeled === true) return type
  return prod.productName ? `${prod.productName} · ${type}` : prod.name ?? type
}

export default function PaniniPackMarket() {
  const [data, setData] = useState<PaniniPackMarketResponse | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchJson<PaniniPackMarketResponse>("/api/panini-pack-market").then((r) => {
      if (cancelled) return
      // The discriminator is `ok`, never the payload: a failed read is not an empty board.
      if (!r.ok || !r.json || !Array.isArray(r.json.products)) {
        setFailed(true)
        return
      }
      setData(r.json)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (failed) {
    return (
      <div role="alert" style={{ padding: "16px 20px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 8 }}>
        <div style={{ fontFamily: display, fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", textTransform: "uppercase" }}>Couldn&apos;t load packs</div>
        <Note>Pack market is unavailable right now.</Note>
      </div>
    )
  }
  if (!data) {
    return (
      <div aria-busy="true" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rpc-skeleton" style={{ width: 150, height: 72, borderRadius: 8 }} />
        ))}
      </div>
    )
  }

  const history = data.history

  return (
    <div>
      <h1 style={{ fontFamily: display, fontWeight: 900, fontSize: 24, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 6px" }}>
        Panini — Pack Market
      </h1>
      <Note>
        Sealed Panini NFT packs, bought and sold on Panini&apos;s own marketplace. Prices and supply are Panini&apos;s market
        stats as of RPC&apos;s last walk. Pack EV is modeled per product, and only once every card family in the pack is priced mostly from real
        sales, not asks; other packs show market stats and say so. Read the typical pull first: it is what the median pack holds. The mean is dragged up by chase cards most
        packs never contain, and it is priced off FMV on a listing-fed index, so it is indicative pull value, not what the cards would sell for.
      </Note>

      <div style={{ marginTop: 12 }}>
        <PaniniCoverageNote coverage={data.coverage} failed={data.coverage_error} />
      </div>

      {data.products.length === 0 ? (
        <div style={{ marginTop: 16 }}>
          <Note>No Panini pack products are tracked.</Note>
        </div>
      ) : (
        data.products.map((p) => <ProductCard key={p.id} p={p} staleAfterHours={data.stale_after_hours} />)
      )}
      {data.details_error ? (
        <div style={{ marginTop: 8 }}>
          <Note>Pack contents and top-sale figures couldn&apos;t be loaded right now.</Note>
        </div>
      ) : null}

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontFamily: display, fontWeight: 800, fontSize: 16, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 10px" }}>
          Price trail — last {data.history_days} days
        </h2>
        {data.history_error || history === null ? (
          <Note>Couldn&apos;t load the price trail right now.</Note>
        ) : history.length === 0 ? (
          <Note>No pack price changes were recorded in the last {data.history_days} days.</Note>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 420 }}>
              <thead>
                <tr>
                  <th style={th}>Seen</th>
                  <th style={th}>Pack</th>
                  <th style={th}>Floor</th>
                  <th style={th}>Recent sale</th>
                  <th style={th}>Sealed</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 40).map((h, i) => (
                  <tr key={`${h.packId ?? h.packType}-${h.observedAt}-${i}`}>
                    <td style={td}>{ptStamp(h.observedAt)}</td>
                    <td style={td}>{historyLabel(h, data.products)}</td>
                    <td style={td}>{usd(h.floorUsd)}</td>
                    <td style={td}>{usd(h.recentSaleUsd)}</td>
                    <td style={td}>{count(h.packsRemaining)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Note>One row per recorded change, newest first{history.length > 40 ? ` (latest 40 of ${history.length})` : ""}.</Note>
          </div>
        )}
      </section>
    </div>
  )
}
