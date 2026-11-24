// components/insights/CandySqueezeBoard.tsx
//
// The Candy Squeeze Board view, shared by /insights/candy-squeeze (the 2026 sets) and
// /insights/candy-squeeze/set/[setId] (one set, legacy included — 2026-11-23, Candy parity pass 3). Server component:
// the rows are crawlable and nothing here fetches.
//
// Honesty: a failed read renders the degraded notice, never an empty board and never a set list; "0 listed" is always
// dated by the newest sweep; a missing floor is "none listed", never $0. A set RPC cannot vouch for (no Magic Eden
// market, a stale or failed sweep, no clean census walk) is never offered in the picker, so it can never read "0 listed".

import Link from "next/link"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import type { CandySqueezePayload, CandySqueezeSet } from "@/lib/insights/candy-parity-boards"
import { fmtBoardUsd } from "@/lib/insights/pinnacle-board-format"
import { editionRouteHref } from "@/lib/entity-href"

const cell: React.CSSProperties = { padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap" }
const head: React.CSSProperties = { ...cell, fontWeight: 600, color: "var(--rpc-text-muted)" }
const linkStyle: React.CSSProperties = { color: "var(--rpc-text-secondary)", textDecoration: "none" }
const chip: React.CSSProperties = {
  padding: "4px 10px", borderRadius: 999, border: "1px solid var(--rpc-border-subtle)", background: "var(--rpc-surface)",
  color: "var(--rpc-text-secondary)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "nowrap",
}
const chipOn: React.CSSProperties = { ...chip, border: "1px solid var(--rpc-red)", color: "var(--rpc-text-primary)" }

/** How many sets get a chip; the rest sit behind "All sets". */
const PICKER_CHIPS = 18
/** A set with fewer ranked cards than this is not offered in the picker (one listing swings it). */
const PICKER_MIN_RANKED = 5

export const CANDY_SQUEEZE_PATH = "/insights/candy-squeeze"
export function candySqueezeSetPath(setId: string): string {
  return `${CANDY_SQUEEZE_PATH}/set/${encodeURIComponent(setId)}`
}

export function fmtSweep(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" })
}

/** Sets worth offering in the picker: enough ranked cards to read a share from. */
export function pickerSets(sets: CandySqueezeSet[]): CandySqueezeSet[] {
  return sets.filter((s) => s.set_id && s.ranked >= PICKER_MIN_RANKED)
}

function SetPicker({ sets, activeSetId }: { sets: CandySqueezeSet[]; activeSetId: string | null }) {
  const offer = pickerSets(sets)
  if (offer.length === 0) return null
  // The default board already ranks the 2026 sets; every other set (legacy, and the 2024 Team Balls registry set)
  // gets a chip by live asks, the rest by name behind a disclosure.
  const legacy = offer.filter((s) => !(s.registry && s.set_name.startsWith("2026 ")))
  const chips = legacy.slice(0, PICKER_CHIPS)
  const rest = [...legacy.slice(PICKER_CHIPS)].sort((a, b) => a.set_name.localeCompare(b.set_name))
  return (
    <nav aria-label="Pick a Candy set" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <Link prefetch={false} href={CANDY_SQUEEZE_PATH} style={activeSetId === null ? chipOn : chip}>Current sets</Link>
        {chips.map((s) => (
          <Link key={s.set_id} prefetch={false} href={candySqueezeSetPath(s.set_id)} style={s.set_id === activeSetId ? chipOn : chip}>
            {s.set_name} · {s.asks.toLocaleString("en-US")} listed
          </Link>
        ))}
      </div>
      {rest.length > 0 ? (
        <details style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
          <summary style={{ cursor: "pointer" }}>All sets ({offer.length.toLocaleString("en-US")})</summary>
          <ul style={{ columns: "260px", margin: "8px 0 0", paddingLeft: 16, lineHeight: 1.8 }}>
            {rest.map((s) => (
              <li key={s.set_id}>
                <Link prefetch={false} href={candySqueezeSetPath(s.set_id)} style={linkStyle}>{s.set_name}</Link>
                {" "}· {s.ranked.toLocaleString("en-US")} cards, {s.asks.toLocaleString("en-US")} listed
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </nav>
  )
}

export default function CandySqueezeBoard({
  ok,
  data: d,
  activeSet,
}: {
  ok: boolean
  data: CandySqueezePayload
  /** The set this page ranks; null = the default 2026 view. */
  activeSet: CandySqueezeSet | null
}) {
  const title = activeSet ? `Candy Squeeze · ${activeSet.set_name}` : "Candy Squeeze Board"
  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "28px 18px 64px", display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--rpc-red-text)" }}>
          RPC Insights · Public
        </span>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 38, letterSpacing: "0.02em", color: "var(--rpc-text-primary)", textTransform: "uppercase", lineHeight: 1.05 }}>
          {title}
        </h1>
        <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.55, maxWidth: 760 }}>
          {activeSet ? (
            <>
              Which <strong>{activeSet.set_name}</strong> cards are collectors <strong>not selling</strong>? Every card in
              the set with {d.min_held}+ copies in collectors&rsquo; hands, ranked by the share of those copies listed on
              Magic Eden or OpenSea right now — the tightest supply first.
            </>
          ) : (
            <>
              Which 2026 Candy ICONs are collectors <strong>not selling</strong>? Every ICON across the 2026 Base Series,
              All-Star Game and Gold sets with {d.min_held}+ copies in collectors&rsquo; hands, ranked by the share of those
              copies listed on Magic Eden or OpenSea right now — the tightest supply first. Pick any other Candy set below.
            </>
          )}
        </p>
        {ok ? (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Listings as of {fmtSweep(d.listings_seen_at)} · holders counted {fmtSweep(d.holders_counted_at)} ·{" "}
            {d.editions_ranked.toLocaleString("en-US")} cards ranked · {d.editions_zero_listed.toLocaleString("en-US")} with none listed
          </span>
        ) : null}
        {ok ? <SetPicker sets={d.sets} activeSetId={activeSet?.set_id ?? null} /> : null}
      </header>

      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Candy squeeze", ok)])} />

      {d.rows.length > 0 ? (
        <section style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border-subtle)", borderRadius: 8, padding: 12 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr>
                  <th scope="col" style={{ ...head, textAlign: "left" }}>Card</th>
                  <th scope="col" style={head}>Listed</th>
                  <th scope="col" style={head}>Collector-held</th>
                  <th scope="col" style={head}>% listed</th>
                  <th scope="col" style={head}>Floor</th>
                  <th scope="col" style={head}>FMV</th>
                  <th scope="col" style={head}>Sales 30d</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.external_id} style={{ borderTop: "1px solid var(--rpc-border-subtle)" }}>
                    <td style={{ ...cell, textAlign: "left", whiteSpace: "normal", minWidth: 200 }}>
                      <Link prefetch={false} href={editionRouteHref("candy-mlb", r.external_id)} style={{ color: "var(--rpc-text-primary)", textDecoration: "none" }}>
                        {r.player_name ?? r.external_id}
                      </Link>
                      <div style={{ color: "var(--rpc-text-muted)", fontSize: 10, marginTop: 2 }}>{[r.rarity_label, r.set_name].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td style={{ ...cell, fontWeight: 700 }}>{r.listed.toLocaleString("en-US")}</td>
                    <td style={cell}>
                      {r.collector_held.toLocaleString("en-US")}
                      {r.issuer_held > 0 ? <div style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>+{r.issuer_held.toLocaleString("en-US")} Candy-held</div> : null}
                    </td>
                    <td style={{ ...cell, fontWeight: 700 }}>{r.pct_listed != null ? `${r.pct_listed}%` : "—"}</td>
                    <td style={cell}>{r.floor_ask_usd != null ? fmtBoardUsd(r.floor_ask_usd) : "none listed"}</td>
                    <td style={cell}>{fmtBoardUsd(r.fmv_usd)}</td>
                    <td style={cell}>{r.sales_30d.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.editions_ranked > d.rows.length ? (
            <p style={{ margin: "10px 0 0", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
              Showing the {d.rows.length.toLocaleString("en-US")} tightest of {d.editions_ranked.toLocaleString("en-US")} ranked cards.
            </p>
          ) : null}
        </section>
      ) : ok ? (
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)" }}>
          {activeSet ? `No ${activeSet.set_name} card` : "No 2026 ICON"} has {d.min_held}+ collector-held copies.
        </p>
      ) : null}

      <footer style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", lineHeight: 1.7 }}>
        <p style={{ margin: 0 }}>
          Method: <strong>collector-held</strong> = copies in collectors&rsquo; wallets, counted from RPC&rsquo;s on-chain
          census (refreshed every 3 hours); copies in Candy&rsquo;s own wallets (inventory, ICON buyback and pack treasury)
          are shown as Candy-held and left out. <strong>Listed</strong> = Magic Eden and OpenSea listings of the card that
          RPC&rsquo;s sweeps have seen in the last 12 hours (OpenSea&rsquo;s read straight from the Solana chain, each
          confirmed by the card sitting in that listing&rsquo;s escrow), so 0 means none were live at that time.
          Listings on other Solana marketplaces such as Tensor are not counted. Listings left over from before
          Candy&rsquo;s October wallet migration, whose seller no longer holds the card, are not counted, and asks far above
          the card&rsquo;s value are left out. A set appears only while RPC can vouch for its listings: it trades on Magic
          Eden, its last sweep was clean and under 12 hours old, and its holders were fully counted. Ties are broken by
          30-day sales. Cards with fewer than {d.min_held} collector-held copies are left out.
        </p>
        <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Link href="/insights" style={linkStyle}>← All insights</Link>
          <Link href="/insights/candy-serial-premiums" style={linkStyle}>Candy serial premiums</Link>
          <Link href="/insights/candy-mlb?tab=scarcity" style={linkStyle}>Candy scarcity</Link>
          <Link href="/insights/squeeze" style={linkStyle}>Top Shot squeeze</Link>
          <Link href="/candy-mlb/market" style={linkStyle}>Candy market</Link>
        </div>
      </footer>
    </div>
  )
}
