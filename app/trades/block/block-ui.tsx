// app/trades/block/block-ui.tsx
//
// Pieces the Trade Block pages share: one listing line (an offered asset, or a want), a
// line list, and the "what's it worth" line. FMV shows wherever RPC has one (an ask-derived one
// reads "from asks"); otherwise "not priced" — never $0, never a confidence tier. Locked assets
// show in the picker but can't be selected. Offered lines
// that have left RPC's index of their account read "may have moved", never "gone".

import Link from "next/link"
import type { LineView, ListingView } from "@/lib/trade-block/view"
import { valueLine } from "@/lib/trade-block/view"
import { fmvBasis } from "@/lib/fmv-basis"
import { card, DISPLAY, fmtUsd, MONO, muted } from "../trade-ui"

export const BLOCK_COLLECTION_FILTERS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: "", label: "All collections" },
  { slug: "nba-top-shot", label: "NBA Top Shot" },
  { slug: "nfl-all-day", label: "NFL All Day" },
  { slug: "laliga-golazos", label: "LaLiga Golazos" },
  { slug: "disney-pinnacle", label: "Disney Pinnacle" },
  { slug: "ufc", label: "UFC Strike" },
  { slug: "panini-blockchain", label: "Panini" },
  { slug: "candy-mlb", label: "MLB ICONs" },
]

const ASKS = fmvBasis("ASK_ONLY")!

export function lineTitle(l: LineView): string {
  if (l.kind === "player") return `Any ${l.player_name ?? l.person_noun}`
  return l.player_name ?? l.set_name ?? `${l.asset_noun} ${l.moment_id ?? l.edition_key ?? ""}`.trim()
}

export function lineSub(l: LineView): string {
  const bits: string[] = [l.collection]
  if (l.set_name && l.kind !== "player") bits.push(l.set_name)
  if (l.tier) bits.push(l.tier.charAt(0) + l.tier.slice(1).toLowerCase())
  if (l.kind === "edition") bits.push("any serial")
  if (l.kind === "player") bits.push(`any ${l.asset_noun}`)
  if (l.serial_number != null) bits.push(`#${l.serial_number}`)
  return bits.join(" · ")
}

export function Line({ line, selected, onToggle }: { line: LineView; selected?: boolean; onToggle?: () => void }) {
  const body = (
    <>
      {line.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={line.image_url} alt="" width={40} height={40} loading="lazy" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, flex: "0 0 auto", background: "var(--rpc-surface-raised)" }} />
      ) : (
        <div aria-hidden style={{ width: 40, height: 40, borderRadius: 4, flex: "0 0 auto", background: "var(--rpc-surface-raised)" }} />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lineTitle(line)}</div>
        <div style={{ ...muted, fontSize: 12 }}>{lineSub(line)}</div>
        {line.in_index === false ? (
          <div style={{ fontSize: 12, color: "var(--rpc-danger-text)" }}>May have moved — no longer in RPC&apos;s last read of the account it was posted from.</div>
        ) : null}
      </div>
      {line.kind === "moment" ? (
        <div style={{ fontFamily: MONO, fontSize: 12, textAlign: "right", flex: "0 0 auto", color: line.priced ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)" }}>
          {line.priced && line.fmv_usd != null ? fmtUsd(line.fmv_usd) : "not priced"}
          {line.priced && line.from_asks ? (
            <div style={{ ...muted, fontSize: 11 }} title={ASKS.title}>
              {ASKS.label}
            </div>
          ) : null}
          {line.locked ? <div style={{ ...muted, fontSize: 11 }}>locked</div> : null}
        </div>
      ) : null}
    </>
  )
  const row: React.CSSProperties = { display: "flex", gap: 10, alignItems: "center", padding: "6px 0", width: "100%" }
  if (!onToggle) return <div style={row}>{body}</div>
  const blocked = line.locked && !selected
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      disabled={blocked}
      title={blocked ? "Locked — it can't be traded until it's unlocked" : undefined}
      style={{
        ...row,
        padding: "6px 8px",
        textAlign: "left",
        borderRadius: 6,
        border: `1px solid ${selected ? "var(--rpc-red-fill)" : "var(--rpc-border)"}`,
        background: selected ? "var(--rpc-surface-raised)" : "transparent",
        color: "inherit",
        cursor: blocked ? "not-allowed" : "pointer",
        opacity: blocked ? 0.5 : 1,
      }}
    >
      {body}
    </button>
  )
}

export function LineList({ lines, empty }: { lines: LineView[]; empty: string }) {
  if (lines.length === 0) return <p style={{ ...muted, margin: "4px 0" }}>{empty}</p>
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {lines.map((l, i) => (
        <li key={`${l.collection_id}:${l.moment_id ?? l.edition_key ?? l.player_name ?? i}`} style={{ borderTop: i ? "1px solid var(--rpc-border)" : "none" }}>
          <Line line={l} />
        </li>
      ))}
    </ul>
  )
}

export function worth(listing: Pick<ListingView, "value">): string {
  return valueLine(listing.value, fmtUsd)
}

export function ptDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" })
}

export function ListingCard({ l, href }: { l: ListingView; href?: string }) {
  const inner = (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
        <div style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 15 }}>{l.username}</div>
        <div style={{ ...muted, fontSize: 12 }}>
          {l.collections.join(" · ")} · posted {ptDate(l.created_at)}
          {l.state !== "open" ? ` · ${l.state}` : ""}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 8 }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Trading away · {worth(l)}</div>
          <LineList lines={l.offers} empty="Nothing listed." />
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Looking for</div>
          <LineList lines={l.wants} empty={l.open_to_offers ? "Open to offers." : "Nothing named."} />
          {l.wants.length > 0 && l.open_to_offers ? <p style={{ ...muted, fontSize: 12, margin: "4px 0 0" }}>Also open to other offers.</p> : null}
        </div>
      </div>
      {l.note ? <p style={{ fontSize: 13, margin: "8px 0 0", whiteSpace: "pre-wrap" }}>&ldquo;{l.note}&rdquo;</p> : null}
    </>
  )
  if (!href) return <section style={card}>{inner}</section>
  return (
    <Link href={href} style={{ ...card, display: "block", textDecoration: "none", color: "inherit" }}>
      {inner}
    </Link>
  )
}
