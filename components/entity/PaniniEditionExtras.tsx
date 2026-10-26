// components/entity/PaniniEditionExtras.tsx
//
// Panini edition-page sections that bring it level with Top Shot's (parity pass 2026-10-25):
// Offers (≈ Top Shot's Activity → Offers), Holders (≈ Top Owners, COUNTS ONLY — no Panini
// username is ever shown, the 2026-10-21 Holders-board decision) and Packs from this product
// (≈ Found in packs; Panini publishes no per-pack checklist, so this is the product's packs and
// says so). Data: lib/panini/edition-extras.ts. Pure props so a test renders every state.
//
// Three states per section: null = the read failed ("couldn't be loaded"), [] / no row = ok and
// empty (said plainly, never as "none exist"), rows.

import Link from "next/link"
import type { CSSProperties } from "react"
import { Section, fmtUsd, fmtCount, fmtShare, relTime } from "@/components/entity/_shared"
import { scrollRegion } from "@/lib/a11y/scroll-region"
import { PANINI_ASK_CONFIRMED_DAYS } from "@/lib/panini/edition-market"
import type { PaniniEditionOffers, PaniniEditionHolders, PaniniEditionPacks, PaniniAskChange } from "@/lib/panini/edition-extras"
import { paniniProductHref, paniniProductSlug } from "@/lib/panini/product-url"

/** Concentration shares mean nothing on a handful of copies — the Holders board's own floor. */
export const PANINI_HOLDERS_MIN_OWNED_FOR_SHARE = 10

/** The ask-history lane (migration 20261026040131) holds nothing before this PT day. */
export const PANINI_ASK_HISTORY_SINCE = "2026-10-21"

const cell: CSSProperties = { padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle, var(--rpc-border))" }
const head: CSSProperties = { ...cell, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }
const sub: CSSProperties = { marginTop: -6, marginBottom: 10, fontSize: 11, color: "var(--rpc-text-muted)" }

function Note({ children, testId }: { children: string; testId?: string }) {
  return (
    <div data-testid={testId} style={{ padding: "12px 14px", border: "1px dashed var(--rpc-border)", borderRadius: 6, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
      {children}
    </div>
  )
}

function serialLabel(serial: number | null, cap: number | null): string {
  if (serial == null) return "—"
  return cap != null ? `#${serial}/${cap}` : `#${serial}`
}

export function PaniniOffersSection({ offers }: { offers: PaniniEditionOffers }) {
  const rows = offers.rows
  return (
    <Section title="Offers">
      <div className="rpc-mono" style={sub}>
        The best offer Panini&rsquo;s marketplace showed on each serial, re-read in the last {PANINI_ASK_CONFIRMED_DAYS} days, highest first.
        {offers.serialsWithOffer != null && rows && rows.length > 0
          ? ` ${fmtCount(offers.serialsWithOffer)} serial${offers.serialsWithOffer === 1 ? "" : "s"} carry one.`
          : ""}
      </div>
      {rows === null ? (
        <Note testId="panini-offers-failed">Offers couldn&apos;t be loaded — refresh to try again.</Note>
      ) : rows.length === 0 ? (
        <Note testId="panini-offers-empty">{`No offer on this edition has been re-read in the last ${PANINI_ASK_CONFIRMED_DAYS} days.`}</Note>
      ) : (
        <div className="rpc-scroll-x" {...scrollRegion("Offers on this edition")}>
          <table data-testid="panini-offers" style={{ borderCollapse: "collapse", width: "100%", minWidth: 420 }}>
            <thead>
              <tr>
                <th scope="col" style={head}>Serial</th>
                <th scope="col" style={head}>Best offer</th>
                <th scope="col" style={head}>Offers</th>
                <th scope="col" style={head}>Ask</th>
                <th scope="col" style={head}>Seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.serial}-${i}`}>
                  <td style={cell}>
                    {serialLabel(r.serial, r.mintCap)}
                    {r.sealed ? <span style={{ color: "var(--rpc-text-muted)" }}> · still in a pack</span> : null}
                  </td>
                  <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>{fmtUsd(r.bestOfferUsd)}</td>
                  <td style={cell}>{r.offersCount != null ? fmtCount(r.offersCount) : "—"}</td>
                  <td style={cell}>{r.askUsd != null ? fmtUsd(r.askUsd) : "not listed"}</td>
                  <td style={cell}>{r.seenAt ? relTime(r.seenAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

export function PaniniHoldersSection({ ok, holders }: { ok: boolean; holders: PaniniEditionHolders | null }) {
  if (!ok) {
    return (
      <Section title="Holders">
        <Note testId="panini-holders-failed">Holder counts couldn&apos;t be loaded — refresh to try again.</Note>
      </Section>
    )
  }
  if (!holders) {
    return (
      <Section title="Holders">
        <Note testId="panini-holders-empty">RPC hasn&apos;t counted this edition&apos;s holders yet — counts refresh daily from the serials it has seen.</Note>
      </Section>
    )
  }
  const h = holders
  const showShares = h.censusComplete && (h.ownedCopies ?? 0) >= PANINI_HOLDERS_MIN_OWNED_FOR_SHARE
  const stat = (label: string, value: string, testId?: string) => (
    <div data-testid={testId} style={{ padding: "10px 12px", border: "1px solid var(--rpc-border)", borderRadius: 4 }}>
      <div className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>{label}</div>
      <div className="rpc-mono" style={{ fontSize: 16, fontWeight: 700, color: "var(--rpc-text-primary)", marginTop: 2 }}>{value}</div>
    </div>
  )
  return (
    <Section title="Holders">
      <div className="rpc-mono" style={sub}>
        Counted from the {fmtCount(h.serialsSeen)} serial{h.serialsSeen === 1 ? "" : "s"} RPC has seen{h.computedAt ? `, ${relTime(h.computedAt)}` : ""}.
        Collectors are counted, never named. A serial with no owner is still sealed in a pack.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
        {stat("Collectors", fmtCount(h.holders), "panini-holders-count")}
        {stat("Owned copies", fmtCount(h.ownedCopies))}
        {stat("Still in packs", fmtCount(h.unopenedCopies))}
        {h.burntCopies ? stat("Burned", fmtCount(h.burntCopies)) : null}
        {showShares ? stat("Top holder", `${fmtShare((h.top1Share ?? 0) * 100)} · ${fmtCount(h.top1Copies)}`, "panini-holders-top1") : null}
        {showShares ? stat("Top 3 holders", `${fmtShare((h.top3Share ?? 0) * 100)} · ${fmtCount(h.top3Copies)}`) : null}
      </div>
      {!showShares ? (
        <div className="rpc-mono" data-testid="panini-holders-no-share" style={{ marginTop: 8, fontSize: 11, color: "var(--rpc-text-muted)" }}>
          {h.censusComplete
            ? `Concentration is shown once at least ${PANINI_HOLDERS_MIN_OWNED_FOR_SHARE} copies are owned.`
            : "RPC hasn't seen every serial of this edition, so it doesn't state how concentrated ownership is."}
        </div>
      ) : null}
    </Section>
  )
}

export function PaniniProductPacksSection({
  packs,
  collection,
  mode = "edition",
}: {
  packs: PaniniEditionPacks
  collection: string
  /** "product" = rendered on the product page itself: no per-card wording, no link back to the product. */
  mode?: "edition" | "product"
}) {
  const list = packs.packs
  const productSlug = mode === "edition" && packs.productSetId != null ? paniniProductSlug(packs.productName, packs.productSetId) : null
  const productHref = productSlug ? paniniProductHref(collection, productSlug) : null
  return (
    <Section title={mode === "product" ? "Packs" : "Packs From This Product"}>
      <div className="rpc-mono" style={sub}>
        {mode === "product"
          ? "Packs RPC tracks for this product. Panini publishes no per-pack checklist."
          : packs.fotlExclusive
          ? "This card is a First Off The Line exclusive — only FOTL packs carry it."
          : `Packs Panini sells from ${packs.productName ?? "this card's product"}. Panini publishes no per-pack checklist, so RPC can't say which of them can pull this card.`}
        {mode === "edition" && packs.stillInPacks != null ? ` ${fmtCount(packs.stillInPacks)} cop${packs.stillInPacks === 1 ? "y" : "ies"} of this edition are still sealed.` : ""}
      </div>
      {productHref ? (
        <Link href={productHref} data-testid="panini-product-link" className="rpc-mono" style={{ display: "inline-block", marginBottom: 10, fontSize: 11, letterSpacing: "0.04em", color: "var(--rpc-red-text)", textDecoration: "none" }}>
          {packs.productName ? `All of ${packs.productName} →` : "All of this card's product →"}
        </Link>
      ) : null}
      {list === null ? (
        <Note testId="panini-packs-failed">Packs couldn&apos;t be loaded — refresh to try again.</Note>
      ) : list.length === 0 ? (
        <Note testId="panini-packs-empty">{mode === "product" ? "RPC tracks no pack for this product." : "RPC tracks no pack for this card's product."}</Note>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="panini-product-packs">
          {list.map((p) => (
            <div key={p.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "center", padding: "8px 10px", border: "1px solid var(--rpc-border)", borderRadius: 4 }}>
              <div>
                <div className="rpc-mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--rpc-text-primary)" }}>{p.title}</div>
                <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>
                  {p.packsRemaining != null && p.packsTotal != null
                    ? `${fmtCount(p.packsRemaining)} of ${fmtCount(p.packsTotal)} left`
                    : p.packsRemaining != null
                      ? `${fmtCount(p.packsRemaining)} left`
                      : "supply not published"}
                  {p.updatedAt ? ` · ${relTime(p.updatedAt)}` : ""}
                  {p.marketUrl ? (
                    <>
                      {" · "}
                      <a href={p.marketUrl} target="_blank" rel="noopener noreferrer nofollow" style={{ color: "var(--rpc-text-secondary)" }}>
                        View on Panini ↗
                      </a>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="rpc-mono" style={{ textAlign: "right", fontSize: 12, color: "var(--rpc-text-primary)" }}>
                {p.costUsd != null ? fmtUsd(p.costUsd) : "—"}
                <div style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>
                  {p.costBasis === "floor" ? "floor" : p.costBasis === "avg_sale" ? "avg sale" : "no price"}
                </div>
              </div>
            </div>
          ))}
          <Link href={`/${collection}/packs`} className="rpc-mono" style={{ marginTop: 4, fontSize: 11, letterSpacing: "0.04em", color: "var(--rpc-red-text)", textDecoration: "none" }}>
            Pack values and what a typical pack pulls →
          </Link>
        </div>
      )}
    </Section>
  )
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
/** "2026-10-24" → "Oct 24, 2026" — read as a calendar day, never through a timezone. */
export function fmtDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return day
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`
}

/**
 * Ask history (≈ Top Shot's ask-over-time). One row per day the lowest confirmed ask CHANGED,
 * newest first, with the move against the previous recorded ask. A null ask reads "no confirmed
 * ask" — never "$0", never "sold out".
 */
export function PaniniAskHistorySection({ rows }: { rows: PaniniAskChange[] | null }) {
  const since = fmtDay(PANINI_ASK_HISTORY_SINCE)
  return (
    <Section title="Ask history">
      <div className="rpc-mono" style={sub}>
        The lowest ask RPC confirmed on Panini&rsquo;s marketplace, one row for each day it changed. Recorded since {since}.
      </div>
      {rows === null ? (
        <Note testId="panini-ask-history-failed">Ask history couldn&apos;t be loaded — refresh to try again.</Note>
      ) : rows.length === 0 ? (
        <Note testId="panini-ask-history-empty">{`RPC hasn't recorded a confirmed ask for this edition since ${since}.`}</Note>
      ) : (
        <div className="rpc-scroll-x" {...scrollRegion("Ask history for this edition")}>
          <table data-testid="panini-ask-history" style={{ borderCollapse: "collapse", width: "100%", minWidth: 360 }}>
            <thead>
              <tr>
                <th scope="col" style={head}>Day</th>
                <th scope="col" style={head}>Lowest ask</th>
                <th scope="col" style={head}>Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const prev = rows[i + 1]?.lowAskUsd ?? null
                const move =
                  r.lowAskUsd != null && prev != null && prev > 0 ? ((r.lowAskUsd - prev) / prev) * 100 : null
                return (
                  <tr key={r.day}>
                    <td style={cell}>{fmtDay(r.day)}</td>
                    <td style={{ ...cell, color: r.lowAskUsd != null ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)" }}>
                      {r.lowAskUsd != null ? fmtUsd(r.lowAskUsd) : "no confirmed ask"}
                    </td>
                    <td style={cell}>
                      {move == null ? "—" : `${move > 0 ? "+" : ""}${move.toFixed(1)}%`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}
