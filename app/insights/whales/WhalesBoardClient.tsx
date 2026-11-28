"use client"

// app/insights/whales/WhalesBoardClient.tsx
//
// Client layer for the public Whale Watch board. The server page passes the whole
// precomputed board in as `initialBoard` (crawlable). The 7d / 30d toggle selects
// a loaded window locally — there is no refetch.
//
// Honesty: a FAILED read renders as a failure ("couldn't load"), never as "no
// whales"; an OK read with no rows says so in words. People are named by their
// marketplace username; a buyer with none shows a shortened wallet marked "…".
// A name links to that collection's wallet page (rel=nofollow, as Top Fans does).
// The collection chips switch the leaderboard to one collection's own top 10, so
// Panini's six-figure prints don't drown every other collection.

import { useState } from "react"
import Link from "next/link"
import { FreshnessStamp } from "@/components/insights/FreshnessStamp"
import {
  whaleName,
  whaleHref,
  whaleCollectionLabel,
  WHALE_COLLECTION_ORDER,
  type WhaleWatchBoard,
  type WhaleWindow,
  type WhaleMove,
} from "@/lib/whale-watch-board"
import { usdSignFirst } from "@/lib/usd-format"
import { onTablistKeyDown } from "@/lib/a11y/tablist-keys"

const WINDOWS: { val: WhaleWindow; label: string }[] = [
  { val: "7d", label: "7 days" },
  { val: "30d", label: "30 days" },
]

function fmtMoney(n: number | null | undefined): string {
  const neg = usdSignFirst(n, fmtMoney); if (neg !== null) return neg
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`
  return `$${n.toFixed(2)}`
}

function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return Number(n).toLocaleString("en-US")
}

const PT_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })
function fmtDay(iso: string): string {
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? PT_DAY.format(d) : "—"
}

const card: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  padding: 16,
}
const h2: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 900,
  fontSize: 18,
  textTransform: "uppercase",
  letterSpacing: "0.02em",
  margin: "0 0 12px",
}
const dim = "rgba(255,255,255,0.55)"
const mono: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 12 }

type Props = {
  initialBoard: WhaleWatchBoard
  initialFetchedAt: string | null
  /** Did the server-side read fail? EMPTY_WHALE_BOARD is the fallback, so emptiness alone cannot say. */
  initialFailed?: boolean
}

export default function WhalesBoardClient({ initialBoard, initialFailed = false }: Props) {
  const board = initialBoard
  const [win, setWin] = useState<WhaleWindow>("7d")
  const [coll, setColl] = useState<string>("all")
  const collChips = WHALE_COLLECTION_ORDER.filter((c) => board.by_collection[c])
  const leaders = coll === "all" ? board.leaders[win] ?? [] : board.by_collection[coll]?.[win] ?? []
  const collWord = coll === "all" ? "" : ` on ${whaleCollectionLabel(coll)}`

  return (
    <main style={{ minHeight: "100vh", background: "var(--rpc-surface)", color: "#fafafa", padding: "28px 16px 64px" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>
        <div style={{ ...mono, color: "var(--rpc-red-text)", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 }}>
          Insights · every collection
        </div>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 34, textTransform: "uppercase", lineHeight: 1.05, margin: "0 0 10px" }}>
          Whale Watch
        </h1>
        <p style={{ color: "rgba(255,255,255,0.78)", maxWidth: 720, margin: "0 0 8px", fontSize: 15, lineHeight: 1.5 }}>
          The collectors behind the biggest sales on Top Shot, All Day, Panini, Candy MLB, Pinnacle, Golazos and UFC Strike — who
          is spending the most right now, and what they just bought.
        </p>
        <div style={{ ...mono, color: dim, marginBottom: 22 }}>
          {board.computed_at ? (
            <>Updated <FreshnessStamp iso={board.computed_at} /> · refreshes hourly</>
          ) : null}
        </div>

        {initialFailed ? (
          <div role="alert" style={{ ...card, borderColor: "rgba(239,68,68,0.4)", marginBottom: 24 }}>
            We couldn&apos;t load Whale Watch just now. This is a loading problem, not a quiet market — try again in a few minutes.
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 24 }}>
              <Stat label="Whales tracked" value={fmtInt(board.tracked_wallets)} />
              <Stat label="Active this week" value={fmtInt(board.active_7d)} />
              <Stat label="Spent this week" value={fmtMoney(board.spend_7d_usd)} />
              <Stat label="New whales this week" value={fmtInt(board.new_tracked_7d)} />
            </div>

            <section style={{ ...card, marginBottom: 24 }} aria-labelledby="ww-leaders">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                <h2 id="ww-leaders" style={{ ...h2, margin: 0 }}>Biggest spenders</h2>
                <div role="tablist" aria-label="Window" onKeyDown={onTablistKeyDown} tabIndex={-1} style={{ display: "flex", gap: 6 }}>
                  {WINDOWS.map((w) => (
                    <button
                      key={w.val}
                      role="tab"
                      aria-selected={w.val === win}
                      tabIndex={w.val === win ? 0 : -1}
                      onClick={() => setWin(w.val)}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 4,
                        border: "1px solid rgba(255,255,255,0.15)",
                        background: w.val === win ? "var(--rpc-red-fill)" : "transparent",
                        color: "#fff",
                        fontFamily: "var(--font-display)",
                        fontWeight: 700,
                        fontSize: 12,
                        textTransform: "uppercase",
                        cursor: "pointer",
                      }}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>
              {collChips.length > 0 && (
                <div role="group" aria-label="Collection" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                  {["all", ...collChips].map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={c === coll}
                      onClick={() => setColl(c)}
                      style={chip(c === coll)}
                    >
                      {c === "all" ? "All collections" : whaleCollectionLabel(c)}
                    </button>
                  ))}
                </div>
              )}
              {leaders.length === 0 ? (
                <p style={{ color: dim, margin: 0 }}>No tracked whale bought anything{collWord} in the last {win === "7d" ? "7" : "30"} days.</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                    <thead>
                      <tr style={{ color: dim, ...mono, textAlign: "left" }}>
                        <th scope="col" style={th}>#</th>
                        <th scope="col" style={th}>Collector</th>
                        <th scope="col" style={{ ...th, textAlign: "right" }}>Spent</th>
                        <th scope="col" style={{ ...th, textAlign: "right" }}>Buys</th>
                        <th scope="col" style={{ ...th, textAlign: "right" }}>Biggest buy</th>
                        {coll === "all" && <th scope="col" style={th}>Collections</th>}
                        <th scope="col" style={th}>Last buy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaders.map((l) => (
                        <tr key={`${win}-${l.rank}`} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                          <td style={{ ...td, ...mono, color: dim }}>{l.rank}</td>
                          <td style={{ ...td, fontWeight: 700 }}>
                            <WhaleLink name={whaleName(l)} href={whaleHref(coll === "all" ? l.top_collection : coll, l.key)} />
                          </td>
                          <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{fmtMoney(l.spent_usd)}</td>
                          <td style={{ ...td, textAlign: "right" }}>
                            {fmtInt(l.buys)}
                            {l.pack_buys > 0 ? <span style={{ color: dim }}> ({fmtInt(l.pack_buys)} packs)</span> : null}
                          </td>
                          <td style={{ ...td, textAlign: "right" }}>{fmtMoney(l.biggest_usd)}</td>
                          {coll === "all" && (
                            <td style={{ ...td, color: "rgba(255,255,255,0.8)" }}>{l.collections.map(whaleCollectionLabel).join(", ")}</td>
                          )}
                          <td style={{ ...td, ...mono, color: dim }}>{fmtDay(l.last_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 24 }}>
              <MoveList
                id="ww-moves"
                title="Latest big buys"
                subtitle="Whale buys of $250 or more in the last 7 days, newest first."
                rows={board.moves}
                empty="No whale bought anything for $250 or more in the last 7 days."
              />
              <MoveList
                id="ww-biggest"
                title="Biggest buys this month"
                subtitle="The largest single purchases by tracked whales in the last 30 days."
                rows={board.biggest_30d}
                empty="No whale purchases in the last 30 days."
              />
            </div>
          </>
        )}

        <section style={{ marginTop: 32, color: dim, fontSize: 13, lineHeight: 1.6, maxWidth: 760 }} aria-labelledby="ww-how">
          <h2 id="ww-how" style={{ ...h2, fontSize: 14, color: "rgba(255,255,255,0.8)" }}>How this works</h2>
          <p style={{ margin: "0 0 8px" }}>
            A <strong>whale</strong> is anyone who has bought one of a collection&apos;s 25 biggest sales in a calendar month (at least
            $100). Moments, Cards and Pins are ranked separately from packs. Once someone qualifies, we keep watching them.
          </p>
          <p style={{ margin: "0 0 8px" }}>
            Spend counts <strong>purchases only</strong>, from on-chain and marketplace sale records. Trades between two collectors who
            have each bought a top sale from the other are left out, so a card passing back and forth between them isn&apos;t counted as
            new money.
          </p>
          <p style={{ margin: 0 }}>
            Collectors are shown by their marketplace username; one we can&apos;t name shows a shortened wallet. For every big sale with
            its buyer and seller, see <Link href="/insights/top-sales" style={{ color: "var(--rpc-red-text)" }}>Top Sales</Link>.
          </p>
        </section>
      </div>
    </main>
  )
}

const th: React.CSSProperties = { padding: "8px 8px", fontWeight: 400, whiteSpace: "nowrap" }
const td: React.CSSProperties = { padding: "10px 8px", verticalAlign: "top" }

function chip(on: boolean): React.CSSProperties {
  return {
    padding: "5px 10px",
    minHeight: 32,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.15)",
    background: on ? "rgba(255,255,255,0.12)" : "transparent",
    color: on ? "#fff" : "rgba(255,255,255,0.75)",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    cursor: "pointer",
  }
}

function WhaleLink({ name, href }: { name: string; href: string | null }) {
  if (!href) return <>{name}</>
  return (
    <Link href={href} rel="nofollow" prefetch={false} style={{ color: "inherit", textDecoration: "underline", textDecorationColor: "rgba(255,255,255,0.3)", textUnderlineOffset: 3 }}>
      {name}
    </Link>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={card}>
      <div style={{ ...mono, color: dim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 26 }}>{value}</div>
    </div>
  )
}

function MoveList({ id, title, subtitle, rows, empty }: { id: string; title: string; subtitle: string; rows: WhaleMove[]; empty: string }) {
  return (
    <section style={card} aria-labelledby={id}>
      <h2 id={id} style={h2}>{title}</h2>
      <p style={{ color: dim, fontSize: 13, margin: "-6px 0 12px" }}>{subtitle}</p>
      {rows.length === 0 ? (
        <p style={{ color: dim, margin: 0 }}>{empty}</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {rows.map((m, i) => (
            <li key={`${m.at}-${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 0", borderTop: i ? "1px solid rgba(255,255,255,0.06)" : "none" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>
                  <WhaleLink name={whaleName(m)} href={whaleHref(m.collection, m.key)} />
                </div>
                <div style={{ color: "rgba(255,255,255,0.8)", fontSize: 13, overflowWrap: "anywhere" }}>
                  {m.item ?? (m.kind === "pack" ? "Pack" : "—")}
                </div>
                <div style={{ ...mono, color: dim }}>
                  {whaleCollectionLabel(m.collection)} · {fmtDay(m.at)}
                </div>
              </div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 18, whiteSpace: "nowrap" }}>{fmtMoney(m.price_usd)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
