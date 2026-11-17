"use client"

// app/insights/trade-in/TradeInBoardClient.tsx
//
// Client interactivity for /insights/trade-in. Renders the server's initialRows
// (cheapest pack first, every player) immediately for crawlers, then refetches
// /api/public/insights/trade-in when the reader types a player or switches sort.
// The second arm, "what do my Moments count for", takes a Flow address and reads
// the wallet's per-player trade-in value from the same route (?wallet=), with the
// cheapest listed way to each player's NEXT pack. `?player=` / `?wallet=` in the
// page URL pre-run either arm (the player pages and the dashboard link in).
//
// FACTS only: Top Shot's own average sale price (what its trade-in counts) and
// Top Shot's lowest ask. No FMV and no confidence (lib/insights/trade-in-board.ts).
// A failed read is a banner, never "no editions" or "no Moments".

import { useEffect, useRef, useState, type CSSProperties } from "react"
import Link from "next/link"
import {
  ASP_PER_PACK_USD,
  tradeInEditionHref,
  type TradeInFill,
  type TradeInPortfolioRow,
  type TradeInRow,
  type TradeInSort,
} from "@/lib/insights/trade-in-board"
import { fetchJson } from "@/lib/analytics/fetch-json"
import { shortSeriesLabel } from "@/lib/series-label"
import { onTablistKeyDown } from "@/lib/a11y/tablist-keys"

function fmtUsd(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}
function fmtMult(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  return v >= 10 ? `${Math.round(v).toLocaleString("en-US")}×` : `${v.toFixed(1)}×`
}
function fmtSupply(r: TradeInRow): string {
  if (r.live_supply != null) return `${r.live_supply.toLocaleString("en-US")} live`
  return r.circulation_count != null ? `/${r.circulation_count.toLocaleString("en-US")}` : "—"
}

const SORTS: { key: TradeInSort; label: string; blurb: string }[] = [
  { key: "cost", label: "Cheapest pack", blurb: "Editions where buying enough Moments at the ask to reach $10 of ASP costs the least." },
  { key: "ratio", label: "Counts most vs cost", blurb: "Editions whose ASP is the largest multiple of their lowest ask." },
  { key: "asp", label: "Highest ASP", blurb: "Editions that count for the most per Moment." },
]

type PortfolioState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ok"; wallet: string; players: TradeInPortfolioRow[]; total: number; withFill: number; packsTotal: number; nextPack: TradeInFill[] }

/** How many of the cheapest next packs render before "show all". */
const NEXT_PACK_FOLD = 25

export default function TradeInBoardClient({
  initialRows,
  initialFailed = false,
  initialFetchedAt,
}: {
  initialRows: TradeInRow[]
  /** TRUE when the SERVER read failed, so `initialRows`'s `[]` is an absence of data, not "no editions". */
  initialFailed?: boolean
  /** `null` when the server read FAILED — the stamp then renders "—", never a clock. */
  initialFetchedAt: string | null
}) {
  const [rows, setRows] = useState<TradeInRow[]>(initialRows)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)
  const [sort, setSort] = useState<TradeInSort>("cost")
  const [player, setPlayer] = useState("")
  const [applied, setApplied] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(initialFailed)
  const ctrlRef = useRef<AbortController | null>(null)
  const [wallet, setWallet] = useState("")
  const [portfolio, setPortfolio] = useState<PortfolioState>({ kind: "idle" })
  const [showAllNext, setShowAllNext] = useState(false)

  // Loads run from the handlers, not from an effect: the server rows already answer
  // the default view, and each action knows exactly which view it asked for.
  function load(nextPlayer: string, nextSort: TradeInSort) {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setLoading(true)
    setLoadFailed(false)
    const qs = new URLSearchParams({ sort: nextSort, limit: "200" })
    if (nextPlayer) qs.set("player", nextPlayer)
    fetchJson<{ rows?: TradeInRow[]; meta?: { fetched_at?: string } }>(`/api/public/insights/trade-in?${qs.toString()}`, { signal: ctrl.signal })
      .then((res) => {
        if (ctrl.signal.aborted) return
        if (!res.ok || !Array.isArray(res.json?.rows)) {
          // Clear rather than keep: stale rows would answer the PREVIOUS view.
          setLoadFailed(true)
          setRows([])
          return
        }
        setRows(res.json.rows as TradeInRow[])
        if (res.json.meta?.fetched_at) setFetchedAt(res.json.meta.fetched_at)
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
  }
  useEffect(() => () => ctrlRef.current?.abort(), [])

  function pickSort(k: TradeInSort) {
    if (k === sort) return
    setSort(k)
    load(applied, k)
  }
  function search(e: React.FormEvent) {
    e.preventDefault()
    const p = player.trim()
    setApplied(p)
    load(p, sort)
  }
  function clearPlayer() {
    setPlayer("")
    setApplied("")
    load("", sort)
  }

  function readWallet(w: string) {
    setPortfolio({ kind: "loading" })
    setShowAllNext(false)
    fetchJson<{ players?: TradeInPortfolioRow[]; next_pack?: TradeInFill[]; meta?: { wallet?: string; total_players?: number; players_with_fill?: number; packs_total?: number } }>(
      `/api/public/insights/trade-in?wallet=${encodeURIComponent(w)}`,
    ).then((res) => {
      if (!res.ok || !Array.isArray(res.json?.players)) return setPortfolio({ kind: "error" })
      setPortfolio({
        kind: "ok",
        wallet: res.json.meta?.wallet ?? w,
        players: res.json.players,
        total: res.json.meta?.total_players ?? res.json.players.length,
        withFill: res.json.meta?.players_with_fill ?? 0,
        // the whole wallet's packs; an answer without the key is summed over what it listed
        packsTotal: res.json.meta?.packs_total ?? res.json.players.reduce((s, p) => s + p.packs, 0),
        nextPack: Array.isArray(res.json.next_pack) ? res.json.next_pack : [],
      })
    })
  }
  function readPortfolio(e: React.FormEvent) {
    e.preventDefault()
    const w = wallet.trim()
    if (!w) return
    readWallet(w)
  }
  function findPlayer(name: string) {
    setPlayer(name)
    setApplied(name)
    load(name, sort)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  // A link can land with ?player= (the player pages) or ?wallet= (the dashboard):
  // run that arm once on mount. The server rows stay underneath until it answers.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const p = sp.get("player")?.trim() ?? ""
    const w = sp.get("wallet")?.trim() ?? ""
    const t = setTimeout(() => {
      if (p) {
        setPlayer(p)
        setApplied(p)
        load(p, "cost")
      }
      if (w) {
        setWallet(w)
        readWallet(w)
      }
    }, 0)
    return () => clearTimeout(t)
    // mount only: the URL is read once, by design
  }, [])

  const sortBlurb = SORTS.find((s) => s.key === sort)?.blurb ?? ""

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 16px 80px" }}>
      <header style={{ marginBottom: 20 }}>
        <div className="rpc-label" style={{ color: "var(--rpc-red-text)", letterSpacing: "0.12em", fontSize: 11 }}>
          SURFACE · LIVE
        </div>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "clamp(28px, 5vw, 44px)", letterSpacing: "0.5px", textTransform: "uppercase", margin: "6px 0 10px", lineHeight: 1.02 }}>
          Top Shot This Trade-In Finder
        </h1>
        <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 760, fontSize: 15, lineHeight: 1.5 }}>
          Top Shot&apos;s Series 2026-27 program counts every ${ASP_PER_PACK_USD} of a player&apos;s Moments, at Top Shot&apos;s own average sale
          price, as one Top Shot This pack of that player. A Moment can count for far more than it costs to buy. This ranks every
          edition by how many Moments reach ${ASP_PER_PACK_USD} of average sale price and what buying them at the lowest ask would
          cost. Confirm eligibility in the Top Shot app before you trade in.
        </p>
      </header>

      <form onSubmit={search} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <input
          value={player}
          onChange={(e) => setPlayer(e.target.value)}
          placeholder="Player, e.g. Nikola Jokić"
          aria-label="Player"
          className="rpc-mono"
          style={input}
        />
        <button type="submit" style={chipBtn(true)}>Find</button>
        {applied ? (
          <button type="button" onClick={clearPlayer} style={chipBtn(false)}>
            Clear
          </button>
        ) : null}
      </form>
      <div role="tablist" onKeyDown={onTablistKeyDown} tabIndex={-1} aria-label="Sort" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        {SORTS.map((s) => (
          <Chip key={s.key} active={sort === s.key} onClick={() => pickSort(s.key)} label={s.label} />
        ))}
      </div>
      <p style={{ fontSize: 12, color: "var(--rpc-text-muted)", margin: "0 0 16px" }}>
        {sortBlurb}
        {applied ? ` Showing ${applied}.` : ""}
      </p>

      <div style={{ overflowX: "auto", opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--rpc-text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              <th scope="col" style={th}>Player</th>
              <th scope="col" style={th}>Edition</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>Supply</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>Top Shot ASP</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>Lowest ask</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>Counts ÷ cost</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>Moments / pack</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>Cost / pack</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.edition_id} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                <td style={td}>
                  <Link href={tradeInEditionHref(r.external_id)} style={{ color: "var(--rpc-text-primary)", textDecoration: "none", fontWeight: 600 }}>
                    {r.player_name ?? "—"}
                  </Link>
                  <div style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>{r.team_name ?? ""}</div>
                </td>
                <td style={td}>
                  <div style={{ color: "var(--rpc-text-secondary)" }}>
                    {r.set_name ?? "—"}
                    {r.series != null ? ` · ${shortSeriesLabel(r.series, "nba-top-shot")}` : ""}
                  </div>
                  <div style={{ fontSize: 10, color: r.printing === "Standard" ? "var(--rpc-text-muted)" : "var(--rpc-red-text)", fontWeight: r.printing === "Standard" ? 400 : 700 }}>
                    {r.printing}
                    {r.tier ? ` · ${r.tier.toLowerCase()}` : ""}
                  </div>
                </td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>{fmtSupply(r)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-primary)", fontWeight: 700 }}>{fmtUsd(r.asp)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-secondary)" }}>{fmtUsd(r.low_ask)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-red-text)", fontWeight: 800 }}>{fmtMult(r.asp_to_ask)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-secondary)" }}>{r.moments_per_pack}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-primary)", fontWeight: 700 }}>{fmtUsd(r.cost_per_pack)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loadFailed ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--rpc-text-muted)" }}>
            Couldn&apos;t load this view just now &mdash; this says nothing about which editions count.
          </div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--rpc-text-muted)" }}>
            {applied ? `No ${applied} edition has both a Top Shot average sale price and a live ask right now.` : "No edition has both a Top Shot average sale price and a live ask right now."}
          </div>
        ) : null}
      </div>

      <section style={{ marginTop: 32, borderTop: "1px solid var(--rpc-border)", paddingTop: 20 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, textTransform: "uppercase", margin: "0 0 6px" }}>What do my Moments count for?</h2>
        <p style={{ color: "var(--rpc-text-secondary)", fontSize: 14, maxWidth: 760, margin: "0 0 10px", lineHeight: 1.5 }}>
          Paste a Top Shot wallet address. Per player: Top Shot&apos;s average sale price summed over the Moments RPC has indexed for it, whole
          packs at ${ASP_PER_PACK_USD} each, how much more would reach the next one &mdash; and the cheapest listed Moment of that player that gets there.
        </p>
        <form onSubmit={readPortfolio} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x…" aria-label="Top Shot wallet address" className="rpc-mono" style={input} />
          <button type="submit" style={chipBtn(true)} disabled={portfolio.kind === "loading"}>
            {portfolio.kind === "loading" ? "Reading…" : "Count my Moments"}
          </button>
        </form>
        {portfolio.kind === "error" ? (
          <p style={{ color: "var(--rpc-text-muted)", fontSize: 13 }}>Couldn&apos;t read that wallet just now &mdash; this says nothing about what it holds. Check the address and try again.</p>
        ) : portfolio.kind === "ok" ? (
          portfolio.players.length === 0 ? (
            <p style={{ color: "var(--rpc-text-muted)", fontSize: 13 }}>
              RPC hasn&apos;t indexed any Top Shot Moments for {portfolio.wallet}. Add it on your <Link href="/dashboard">dashboard</Link> and it will be walked.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <p style={{ fontSize: 12, color: "var(--rpc-text-muted)", margin: "0 0 8px" }}>
                {portfolio.packsTotal.toLocaleString("en-US")} packs across{" "}
                {portfolio.total.toLocaleString("en-US")} players
                {portfolio.total > portfolio.players.length ? ` (showing the ${portfolio.players.length} with the most ASP)` : ""}.
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--rpc-text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    <th scope="col" style={th}>Player</th>
                    <th scope="col" style={{ ...th, textAlign: "right" }}>Moments</th>
                    <th scope="col" style={{ ...th, textAlign: "right" }}>ASP total</th>
                    <th scope="col" style={{ ...th, textAlign: "right" }}>Packs</th>
                    <th scope="col" style={{ ...th, textAlign: "right" }}>To next pack</th>
                    <th scope="col" style={th}>Cheapest way there</th>
                  </tr>
                </thead>
                <tbody>
                  {portfolio.players.map((p) => (
                    <tr key={p.player_name} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                      <td style={td}>
                        <button type="button" onClick={() => findPlayer(p.player_name)} style={{ ...linkBtn }}>
                          {p.player_name}
                        </button>
                      </td>
                      <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-secondary)" }}>
                        {p.moments}
                        {p.moments_with_asp < p.moments ? <div style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>{p.moments - p.moments_with_asp} without an ASP</div> : null}
                      </td>
                      <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-primary)", fontWeight: 700 }}>{fmtUsd(p.asp_total)}</td>
                      <td style={{ ...td, textAlign: "right", color: "var(--rpc-red-text)", fontWeight: 800 }}>{p.packs}</td>
                      <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>{fmtUsd(p.to_next_pack)}</td>
                      <td style={td}>{p.fill ? <FillCell fill={p.fill} /> : <span style={{ color: "var(--rpc-text-muted)" }}>no priced listing right now</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {portfolio.nextPack.length > 0 ? (
                <div style={{ marginTop: 24 }}>
                  <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, textTransform: "uppercase", margin: "0 0 4px" }}>Cheapest next packs</h3>
                  <p style={{ fontSize: 12, color: "var(--rpc-text-muted)", margin: "0 0 8px" }}>
                    Across every player in this wallet, the next pack that costs the least to reach at today&apos;s lowest asks.{" "}
                    {portfolio.withFill < portfolio.total ? `${(portfolio.total - portfolio.withFill).toLocaleString("en-US")} of ${portfolio.total.toLocaleString("en-US")} players have no priced listing right now.` : ""}
                  </p>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: "var(--rpc-text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        <th scope="col" style={th}>Player</th>
                        <th scope="col" style={{ ...th, textAlign: "right" }}>Packs now</th>
                        <th scope="col" style={{ ...th, textAlign: "right" }}>Short by</th>
                        <th scope="col" style={th}>Buy</th>
                        <th scope="col" style={{ ...th, textAlign: "right" }}>Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(showAllNext ? portfolio.nextPack : portfolio.nextPack.slice(0, NEXT_PACK_FOLD)).map((f) => (
                        <tr key={`${f.player_name}:${f.edition_id}`} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                          <td style={td}>
                            <button type="button" onClick={() => findPlayer(f.player_name)} style={{ ...linkBtn }}>
                              {f.player_name}
                            </button>
                          </td>
                          <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-secondary)" }}>{f.packs}</td>
                          <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>{fmtUsd(f.to_next_pack)}</td>
                          <td style={td}><FillCell fill={f} /></td>
                          <td style={{ ...td, textAlign: "right", color: "var(--rpc-red-text)", fontWeight: 800 }}>{fmtUsd(f.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {portfolio.nextPack.length > NEXT_PACK_FOLD && !showAllNext ? (
                    <button type="button" onClick={() => setShowAllNext(true)} style={{ ...chipBtn(false), marginTop: 10 }}>
                      Show all {portfolio.nextPack.length}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        ) : null}
      </section>

      <p style={{ marginTop: 18, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.5 }}>
        Top Shot ASP = the average sale price Top Shot itself reports for the edition, read from Dapper&apos;s Atlas; it is what the
        trade-in counts. Lowest ask = Top Shot&apos;s lowest listing at the last read: one Moment at that price is confirmed, the next may
        cost more. Moments / pack = ceil(${ASP_PER_PACK_USD} ÷ ASP). Cost / pack = Moments / pack × lowest ask. Not every Moment is eligible for
        every trade-in; Top Shot&apos;s own rules decide.{" "}
        {fetchedAt
          ? `Updated ${new Date(fetchedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} PT.`
          : "Updated — (the read did not complete, so there is no data time to show)."}
      </p>
    </main>
  )
}

/** One fill: "2 × $0.35 · Base Set · Series 5 · common" linking to the edition. More than one Moment = the next may cost more. */
function FillCell({ fill }: { fill: TradeInFill }) {
  return (
    <div>
      <Link href={tradeInEditionHref(fill.external_id)} style={{ color: "var(--rpc-text-primary)", textDecoration: "none", fontWeight: 600 }}>
        {fill.moments_needed} × {fmtUsd(fill.low_ask)}
      </Link>
      <span style={{ color: "var(--rpc-text-secondary)" }}>
        {" "}
        · {fill.set_name ?? "—"}
        {fill.series != null ? ` · ${shortSeriesLabel(fill.series, "nba-top-shot")}` : ""}
      </span>
      <div style={{ fontSize: 10, color: fill.printing === "Standard" ? "var(--rpc-text-muted)" : "var(--rpc-red-text)" }}>
        {fill.printing}
        {fill.tier ? ` · ${fill.tier.toLowerCase()}` : ""}
        {` · ASP ${fmtUsd(fill.asp)} each`}
        {fill.moments_needed > 1 ? " · one at this ask is confirmed, the next may cost more" : ""}
      </div>
    </div>
  )
}

const th: CSSProperties = { padding: "8px 10px", fontWeight: 600 }
const td: CSSProperties = { padding: "10px" }
const input: CSSProperties = {
  flex: 1,
  minWidth: 220,
  padding: "6px 10px",
  borderRadius: 999,
  border: "1px solid var(--rpc-border)",
  background: "var(--rpc-bg)",
  color: "var(--rpc-text-primary)",
  fontSize: 12,
}
const linkBtn: CSSProperties = { background: "none", border: 0, padding: 0, color: "var(--rpc-text-primary)", fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontSize: "inherit" }

function chipBtn(active: boolean): CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: 999,
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "var(--font-mono)",
    border: `1px solid ${active ? "var(--rpc-red)" : "var(--rpc-border)"}`,
    background: active ? "var(--rpc-red-fill)" : "transparent",
    color: active ? "#fff" : "var(--rpc-text-secondary)",
  }
}

function Chip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button role="tab" aria-selected={active} onClick={onClick} className="rpc-mono" style={chipBtn(active)}>
      {label}
    </button>
  )
}
