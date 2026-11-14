"use client"

// Serial search (feedback #12359) — every listed Top Shot Moment with serial #N,
// across all editions. Replaces the Sniper's deal table while a serial is set.
//
// ⚠ HONESTY (CLAUDE.md, #149 "a window over a change-only feed is not a census"):
//   - the COVERAGE LINE always renders on a successful read: how many we can
//     CONFIRM are listed right now, and how many were listed when last seen but
//     not re-checked recently;
//   - unconfirmed rows sit in a COLLAPSED section of their own, each with its
//     last-seen date, never mixed into the confirmed list and never shown as live;
//   - an empty confirmed set says "No #N confirmed listed right now", never
//     "none listed";
//   - a failed read says it failed, never "no listings".
// Read-only: the only action is the outbound "View listing" link.
import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { fetchJson } from "@/lib/analytics/fetch-json"
import { relativeDate } from "@/lib/analytics/format"
import { editionHref } from "@/lib/entity-href"
import { marketplaceMomentUrl } from "@/lib/collections"

export type SerialSearchRow = {
  nft_id: string
  listing_resource_id: string | null
  price_usd: number
  serial_number: number
  confirmation: "confirmed_24h" | "confirmed_verified" | "unconfirmed"
  listed_at: string | null
  last_seen_at: string | null
  book_verified_at: string | null
  edition_id: string | null
  external_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  parallel: string | null
  circulation_count: number | null
  fmv_usd: number | null
}

export type SerialSearchCoverage = {
  serial: number
  confirmed_count: number
  unconfirmed_count: number
  returned_confirmed: number
  returned_unconfirmed: number
}

type SerialSearchResponse = { serial: number; coverage: SerialSearchCoverage; rows: SerialSearchRow[] }

const PAGE = 100
const COLLECTION = "nba-top-shot"

const usd = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function serialSearchUrl(serial: number, maxPrice: number, tier: string): string {
  const qs = new URLSearchParams({ serial: String(serial) })
  if (maxPrice > 0) qs.set("maxPrice", String(maxPrice))
  if (tier && tier !== "all") qs.set("tier", tier)
  return `/api/topshot-serial-search?${qs.toString()}`
}

function Rows({ rows, serial, unconfirmed }: { rows: SerialSearchRow[]; serial: number; unconfirmed?: boolean }) {
  const [shown, setShown] = useState(PAGE)
  return (
    <>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--rpc-text-muted)", borderBottom: "1px solid var(--rpc-border)" }}>
              <th scope="col" style={{ padding: "6px 8px 6px 0" }}>Moment</th>
              <th scope="col" style={{ padding: "6px 8px" }}>Set / parallel</th>
              <th scope="col" style={{ padding: "6px 8px" }}>Serial</th>
              <th scope="col" style={{ padding: "6px 8px", textAlign: "right" }}>Ask</th>
              <th scope="col" style={{ padding: "6px 8px", textAlign: "right" }}>FMV</th>
              <th scope="col" style={{ padding: "6px 8px" }}>{unconfirmed ? "Last seen" : "Seen"}</th>
              <th scope="col" style={{ padding: "6px 0 6px 8px" }}><span className="sr-only">Listing</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((r) => {
              const href = r.edition_id ? editionHref(COLLECTION, r.external_id, r.edition_id) : null
              const out = marketplaceMomentUrl(COLLECTION, r.nft_id)
              const seen =
                r.confirmation === "confirmed_verified" && r.book_verified_at
                  ? `book checked ${relativeDate(r.book_verified_at)}`
                  : r.last_seen_at
                    ? relativeDate(r.last_seen_at)
                    : "—"
              const setLine = [r.set_name, r.parallel && r.parallel !== "Standard" ? r.parallel : null].filter(Boolean).join(" · ")
              return (
                <tr key={r.nft_id} data-testid={unconfirmed ? "serial-row-unconfirmed" : "serial-row"} style={{ borderBottom: "1px solid var(--rpc-border)" }}>
                  <td style={{ padding: "6px 8px 6px 0" }}>
                    {href ? (
                      <Link href={href} style={{ color: "var(--rpc-text-primary)" }}>{r.player_name ?? r.set_name ?? "—"}</Link>
                    ) : (
                      <span style={{ color: "var(--rpc-text-primary)" }}>{r.player_name ?? r.set_name ?? "—"}</span>
                    )}
                    {r.tier && <div style={{ fontSize: 10, color: "var(--rpc-text-muted)", textTransform: "uppercase" }}>{r.tier}</div>}
                  </td>
                  <td style={{ padding: "6px 8px", color: "var(--rpc-text-secondary)" }}>{setLine || "—"}</td>
                  <td style={{ padding: "6px 8px", color: "var(--rpc-text-secondary)", whiteSpace: "nowrap" }}>
                    #{r.serial_number || serial}{r.circulation_count ? ` / ${r.circulation_count.toLocaleString("en-US")}` : ""}
                  </td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--rpc-text-primary)" }}>{usd(r.price_usd)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--rpc-text-secondary)" }}>{usd(r.fmv_usd)}</td>
                  <td style={{ padding: "6px 8px", color: "var(--rpc-text-muted)", whiteSpace: "nowrap" }}>{seen}</td>
                  <td style={{ padding: "6px 0 6px 8px", whiteSpace: "nowrap" }}>
                    {out && (
                      <a href={out} target="_blank" rel="noopener noreferrer" style={{ color: "var(--rpc-red-text)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        View listing ↗
                      </a>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          style={{ marginTop: 10, background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--rpc-red-text)", fontFamily: "var(--font-mono)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}
        >
          Show more ({(rows.length - shown).toLocaleString("en-US")} left)
        </button>
      )}
    </>
  )
}

export default function SerialSearchPanel({
  serial,
  maxPrice,
  tier,
  onClear,
}: {
  serial: number
  maxPrice: number
  tier: string
  onClear: () => void
}) {
  const url = serialSearchUrl(serial, maxPrice, tier)
  const [result, setResult] = useState<{ url: string; ok: false } | { url: string; ok: true; data: SerialSearchResponse } | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchJson<SerialSearchResponse>(url).then((r) => {
      if (cancelled) return
      if (!r.ok || !r.json || !r.json.coverage || !Array.isArray(r.json.rows)) setResult({ url, ok: false })
      else setResult({ url, ok: true, data: r.json })
    })
    return () => { cancelled = true }
  }, [url])

  const loading = !result || result.url !== url
  const confirmed = useMemo(() => (result && result.ok ? result.data.rows.filter((r) => r.confirmation !== "unconfirmed") : []), [result])
  const unconfirmed = useMemo(() => (result && result.ok ? result.data.rows.filter((r) => r.confirmation === "unconfirmed") : []), [result])
  const filtered = maxPrice > 0 || (tier && tier !== "all")

  return (
    <section data-testid="serial-search" style={{ maxWidth: "100vw", margin: "0 auto", padding: 16, boxSizing: "border-box" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--font-display)", fontSize: 20, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--rpc-text-primary)" }}>
          Serial #{serial} — every edition
        </h2>
        <button
          type="button"
          onClick={onClear}
          style={{ background: "none", border: "1px solid var(--rpc-border)", borderRadius: 4, padding: "2px 8px", cursor: "pointer", color: "var(--rpc-text-secondary)", fontFamily: "var(--font-mono)", fontSize: 11, textTransform: "uppercase" }}
        >
          Back to deals
        </button>
      </div>

      {loading ? (
        <div style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>Loading every #{serial}…</div>
      ) : !result.ok ? (
        <div className="rpc-hud" role="alert" style={{ borderColor: "var(--rpc-danger)", color: "var(--rpc-danger-text)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
          Couldn&apos;t load #{serial} listings right now. This is a loading error, not an empty result. Try again shortly.
        </div>
      ) : (
        <>
          <p data-testid="serial-coverage" style={{ margin: "0 0 12px", color: "var(--rpc-text-secondary)", fontSize: "var(--text-sm)", lineHeight: 1.5 }}>
            {result.data.coverage.confirmed_count > 0 ? (
              <>
                Every #{serial} we can confirm is listed right now{filtered ? " (matching your filters)" : ""}:{" "}
                <b style={{ color: "var(--rpc-text-primary)" }}>{result.data.coverage.confirmed_count.toLocaleString("en-US")}</b>.
              </>
            ) : (
              <>No #{serial} confirmed listed right now{filtered ? " (matching your filters)" : ""}.</>
            )}{" "}
            That means listings seen in the last 24 h, plus editions whose full listing book we checked in the last 7 days.{" "}
            {result.data.coverage.unconfirmed_count > 0 ? (
              <>
                <b style={{ color: "var(--rpc-text-primary)" }}>
                  {result.data.coverage.unconfirmed_count.toLocaleString("en-US")} more were listed when last seen but not re-checked recently
                </b>
                ; they may have sold.
              </>
            ) : null}
          </p>

          {confirmed.length > 0 && (
            <>
              <Rows rows={confirmed} serial={serial} />
              {result.data.coverage.confirmed_count > result.data.coverage.returned_confirmed && (
                <p style={{ margin: "8px 0 0", color: "var(--rpc-text-muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                  Showing the {result.data.coverage.returned_confirmed.toLocaleString("en-US")} cheapest of {result.data.coverage.confirmed_count.toLocaleString("en-US")}. Add a max price or tier to narrow it.
                </p>
              )}
            </>
          )}

          {unconfirmed.length > 0 && (
            <details data-testid="serial-unconfirmed" style={{ marginTop: 18 }}>
              <summary style={{ cursor: "pointer", color: "var(--rpc-text-secondary)", fontFamily: "var(--font-mono)", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Listed when last seen (not re-checked) · {result.data.coverage.unconfirmed_count.toLocaleString("en-US")}
              </summary>
              <p style={{ margin: "8px 0", color: "var(--rpc-text-muted)", fontSize: 12 }}>
                These were listed the last time we saw them. Nobody has re-checked them recently, so some have probably sold or been delisted.
              </p>
              <Rows rows={unconfirmed} serial={serial} unconfirmed />
            </details>
          )}
        </>
      )}
    </section>
  )
}
