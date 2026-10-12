// components/legal/FmvAccuracyTable.tsx
//
// The published accuracy gate: per collection, the share of priced editions
// whose latest FMV is HIGH or MEDIUM confidence (i.e. backed by recent sales),
// with the time the figure was computed. Rendered on /legal/fmv-methodology
// under #accuracy; the homepage TRUST band links here.
//
// This component is PRESENTATIONAL and server-safe (no hooks, no client). The
// data contract and every honesty decision live in lib/fmv-accuracy/fetchers.ts:
//   * a failed READ renders every share as "unavailable" plus a notice naming
//     the failure as OURS, never as a number — a 0 % out of a 503 is the exact
//     defect class CLAUDE.md calls the most productive on this platform;
//   * a precompute SENTINEL (999 leg-threw, -1 no-denominator) is "unavailable";
//   * a measured share is a LABEL (whole percent, "<1%" under one), never a
//     decimal — the roadmap's "a label beats a number".
//
// ⚠ COPY RULE (founder): no superiority claim over anyone. This table says what
// share of OUR prices rests on recent sales; it compares us to nobody.

import type { AccuracyGateResult, AccuracyRow } from "@/lib/fmv-accuracy/fetchers"
import { shareLabel, ACCURACY_METRIC_COLLECTIONS } from "@/lib/fmv-accuracy/fetchers"
import { getCollection } from "@/lib/collections"

// Labels for the failed-read table come from the same registry mapping the
// fetcher uses, so a collection added there appears here without a second list.
const PLACEHOLDER_ROWS: string[] = ACCURACY_METRIC_COLLECTIONS.map(
  (m) => getCollection(m.collectionId)?.label ?? m.collectionId
)

const TABLE: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  margin: "0 0 12px",
}

const TH: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 10px",
  borderBottom: "1px solid var(--rpc-border)",
  color: "var(--rpc-text-muted)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontWeight: 600,
}

const TD: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid var(--rpc-border)",
  color: "var(--rpc-text-secondary)",
  verticalAlign: "top",
}

const TD_STRONG: React.CSSProperties = {
  ...TD,
  color: "var(--rpc-text-primary)",
  fontWeight: 700,
}

const NOTE: React.CSSProperties = {
  margin: "0 0 14px",
  color: "var(--rpc-text-muted)",
  fontSize: 12,
  lineHeight: 1.6,
}

const UNAVAILABLE_COPY = "unavailable"

/** "2026-10-12 01:48 UTC" — absolute, zone-labelled; this page is cached. */
export function formatAsOf(iso: string | null): string {
  if (!iso) return UNAVAILABLE_COPY
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return UNAVAILABLE_COPY
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

function basisNote(row: AccuracyRow): string | null {
  switch (row.basis) {
    case "measured":
      return null
    case "missing":
      return "no reading published yet"
    case "leg_failed":
      return "the measuring job failed on its last run"
    case "no_denominator":
      return "no priced editions in the window"
    case "out_of_range":
      return "the stored value is not a percentage"
  }
}

export default function FmvAccuracyTable({ result }: { result: AccuracyGateResult }) {
  // ⚠ THREE states. `result.ok === false` is a failed READ (ours); it is not an
  // empty table and must not look like one. The rows are still listed so the
  // reader sees WHICH collections we publish this for.
  if (!result.ok) {
    return (
      <div data-testid="fmv-accuracy-table" data-state="read-failed">
        <p style={NOTE} role="status">
          The accuracy figures could not be read just now. This is a temporary read failure on
          our side, not a measurement — treat every share below as unknown rather than zero,
          and reload shortly.
        </p>
        <table style={TABLE}>
          <thead>
            <tr>
              <th style={TH}>Collection</th>
              <th style={TH}>HIGH + MEDIUM share</th>
              <th style={TH}>As of</th>
            </tr>
          </thead>
          <tbody>
            {/* The collection list is the registry's, not the (failed) read's. */}
            {PLACEHOLDER_ROWS.map((label) => (
              <tr key={label}>
                <td style={TD_STRONG}>{label}</td>
                <td style={TD}>{UNAVAILABLE_COPY}</td>
                <td style={TD}>{UNAVAILABLE_COPY}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const rows = result.rows
  const footnotes = rows
    .map((r) => ({ r, note: basisNote(r) }))
    .filter((x): x is { r: AccuracyRow; note: string } => x.note !== null)

  return (
    <div data-testid="fmv-accuracy-table" data-state="ok">
      <table style={TABLE}>
        <thead>
          <tr>
            <th style={TH}>Collection</th>
            <th style={TH}>HIGH + MEDIUM share</th>
            <th style={TH}>As of</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.collectionId} data-collection={r.collectionId} data-basis={r.basis}>
              <td style={TD_STRONG}>{r.label}</td>
              <td style={r.sharePct === null ? TD : TD_STRONG}>{shareLabel(r.sharePct)}</td>
              <td style={TD}>
                {formatAsOf(r.computedAt)}
                {/* `stale` is decided in the fetcher at build time (48 h), not here. */}
                {r.stale ? " (stale)" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {footnotes.length > 0 && (
        <p style={NOTE}>
          {footnotes.map(({ r, note }, i) => (
            <span key={r.collectionId}>
              {i > 0 ? " · " : ""}
              {r.label}: {note}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}
