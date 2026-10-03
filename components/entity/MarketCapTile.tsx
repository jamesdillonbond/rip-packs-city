// components/entity/MarketCapTile.tsx
//
// Market cap for ONE edition / player / team / set, on that entity's own page.
// Async SERVER component: render it inside <Suspense> so a slow read never holds
// the rest of the page. Reads market_cap_current (refreshed every 2 hours) through
// get_market_cap_entity (lib/entity/market-cap-fetchers.ts), keyed by the same slug
// the page resolves.
//
// Three states, never two:
//   · read failed           → "Couldn't load market cap" (never a number)
//   · read ok, no row       → renders NOTHING (e.g. a Pinnacle character page)
//   · read ok, cap unknown  → "Unknown" + the minted-supply upper bound, never $0
//
// RPC tokens only — no hardcoded hex.

import Link from "next/link"
import { fetchIssuerSplitTileRow, fetchMarketCapTileRow } from "@/lib/entity/market-cap-fetchers"
// ⚠ Nothing here imports from market-cap-board.ts: that module holds the RPC
// reads, and a value import from it would put every page that mounts this tile
// on an unbounded path to them (check-unbounded-server-reads, 2026-10-03). The
// types come via the bounded fetcher module; the helpers from the pure one.
import type { IssuerSplitEditionRow, MarketCapEntityGroup, MarketCapEntityRow } from "@/lib/entity/market-cap-fetchers"
import { collectionDisplayName, fmtCount, fmtUsdCompact, sevenDayChange } from "@/lib/insights/market-cap-format"
import { isSplitKnown, splitStatusShort } from "@/lib/insights/topshot-issuer-split-format"
import { Section, SectionUnavailable, StatCell } from "@/components/entity/_shared"

const GRAIN_NOUN: Record<MarketCapEntityGroup, string> = {
  edition: "editions",
  player: "players",
  team: "teams",
  set: "sets",
  series: "series",
}

function fmtPct(x: number | null, signed = false): string {
  if (x == null || !Number.isFinite(x)) return "—"
  const v = Math.round(x * 1000) / 10
  return `${signed && v > 0 ? "+" : ""}${v}%`
}

/**
 * A Top Shot edition's issuer-held split, read separately from the cap. `failed` =
 * that read died (the cap still renders); `row` = it worked. Absent = not a Top
 * Shot edition, or not a Top Shot edition the split knows — no cell at all.
 */
export type IssuerSplitState = { kind: "failed" } | { kind: "row"; row: IssuerSplitEditionRow }

function IssuerSplitCell({ split }: { split: IssuerSplitState }) {
  if (split.kind === "failed") {
    return <StatCell label="Issuer-Held" value="—" sub="couldn't load the pack / reserve split" />
  }
  const r = split.row
  const known = isSplitKnown(r)
  return (
    <StatCell
      label="Issuer-Held"
      value={fmtCount(r.hidden)}
      sub={
        known
          ? `${fmtCount(r.in_packs)} in unopened packs${r.drops_with_packs ? ` (${fmtCount(r.drops_with_packs)} drop${r.drops_with_packs === 1 ? "" : "s"})` : ""} · ${fmtCount(r.reserve)} reserve, never packed`
          : splitStatusShort(r.split_status)
      }
    />
  )
}

export function MarketCapTileBody({
  row,
  group,
  stale = null,
  split,
}: {
  row: MarketCapEntityRow
  group: MarketCapEntityGroup
  /** From staleSince(): null = fresh, "unknown" = no stamp, else the PT time the figures are from. */
  stale?: string | null
  split?: IssuerSplitState | null
}) {
  const known = row.mcap_usd != null
  const hc = known && row.mcap_usd! > 0 && row.mcap_high_conf_usd != null ? row.mcap_high_conf_usd / row.mcap_usd! : null
  const change = sevenDayChange(row.mcap_usd, row.mcap_usd_7d_ago)
  const partial = row.editions_supply_known < row.editions
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <StatCell
          label="Market Cap"
          value={known ? fmtUsdCompact(row.mcap_usd) : "Unknown"}
          sub={
            known
              ? `${fmtPct(hc)} priced from sales`
              : row.mcap_minted_usd != null
                ? `≤ ${fmtUsdCompact(row.mcap_minted_usd)} on minted supply`
                : "no burn count published"
          }
        />
        <StatCell
          label="Rank"
          value={row.mcap_rank != null ? `#${fmtCount(row.mcap_rank)}` : "—"}
          sub={`of ${fmtCount(row.groups_ranked)} ${GRAIN_NOUN[group]} in ${collectionDisplayName(row.collection_slug)}`}
        />
        <StatCell
          label="Collector-held"
          value={fmtCount(row.collector_held)}
          sub={row.minted != null ? `of ${fmtCount(row.minted)} minted` : undefined}
        />
        <StatCell label="Burned" value={fmtCount(row.burned)} sub={row.issuer_held != null ? `${fmtCount(row.issuer_held)} still with the issuer` : undefined} />
        <StatCell
          label="7-Day Change"
          value={change != null ? fmtPct(change, true) : "—"}
          sub={change != null ? `from ${fmtUsdCompact(row.mcap_usd_7d_ago)}` : "history began Oct 3, 2026"}
        />
        {split && <IssuerSplitCell split={split} />}
      </div>
      {stale && (
        <div className="rpc-mono" role="status" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5, color: "var(--rpc-red)" }}>
          {stale === "unknown"
            ? "When these figures were computed is not recorded — treat them as possibly out of date."
            : `These figures are from ${stale} — the market-cap refresh is behind, so they may be out of date.`}
        </div>
      )}
      <div className="rpc-mono" style={{ marginTop: 10, fontSize: 10, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>
        FMV × collector-held supply — burned Moments and the issuer&apos;s sealed / unreleased stock taken out.
        {partial && group !== "edition" && (
          <> Covers {fmtCount(row.editions_supply_known)} of {fmtCount(row.editions)} editions; the rest have no published burn count.</>
        )}{" "}
        <Link href="/insights/market-cap" style={{ color: "var(--rpc-text-secondary)" }}>All market caps →</Link>
      </div>
    </>
  )
}

export default async function MarketCapTile({
  group,
  collectionDbSlug,
  match,
}: {
  group: MarketCapEntityGroup
  collectionDbSlug: string
  match: string | null | undefined
}) {
  if (!match) return null
  // The issuer-held split exists for Top Shot editions only; read it alongside the
  // cap so neither waits on the other, and so its failure cannot hide the cap.
  const wantSplit = group === "edition" && collectionDbSlug === "nba_top_shot"
  const [capRes, splitRes] = await Promise.allSettled([
    fetchMarketCapTileRow(group, collectionDbSlug, match),
    wantSplit ? fetchIssuerSplitTileRow(match) : Promise.resolve(null),
  ])
  if (capRes.status === "rejected") {
    const e = capRes.reason
    console.error(`[market-cap tile] ${group} ${collectionDbSlug}/${match}`, e instanceof Error ? e.message : e)
    return (
      <Section title="Market Cap">
        <SectionUnavailable noun="market cap" />
      </Section>
    )
  }
  const { row, stale } = capRes.value
  if (!row) return null
  let split: IssuerSplitState | null = null
  if (splitRes.status === "rejected") {
    const e = splitRes.reason
    console.error(`[market-cap tile] issuer split ${match}`, e instanceof Error ? e.message : e)
    split = { kind: "failed" }
  } else if (splitRes.value) {
    split = { kind: "row", row: splitRes.value }
  }
  return (
    <Section title="Market Cap">
      <MarketCapTileBody row={row} group={group} stale={stale} split={split} />
    </Section>
  )
}
