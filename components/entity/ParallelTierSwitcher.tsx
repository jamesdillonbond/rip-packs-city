// components/entity/ParallelTierSwitcher.tsx
// Feature 3 (2026-07-03). Prominent pill switcher at the top of the edition hero
// for jumping between parallel printings of the same setID:playID (Standard /
// Hexwave / Jukebox / …). Each printing is its OWN edition/page (the 2026-06-20
// parallel-conflation de-blend), so these are prefetched <Link>s — NOT a fake
// in-place swap. The printing being viewed is highlighted and non-navigating.
//
// Reuses the subedition_siblings already in the market bundle — no new data
// path. Renders nothing unless a real ladder exists (>= 2 printings), so
// single-printing editions and non-Top-Shot collections show no switcher.
//
// 2026-07-06: each non-Standard pill also shows its premium vs the Standard
// printing (parallel FMV / Standard FMV), computed from the fmv_usd already on
// each sibling — the same intelligence as /insights/parallel-premiums, surfaced
// where people actually browse. A trailing link drills into that full board.

import Link from "next/link"
import { fmtCount } from "./_shared"
import {
  fmtMult,
  siblingBaseFmv,
  premiumMultiple,
  isPremiumShown,
  hasAnyPremium,
  pillName,
} from "@/lib/entity-parallel-tier-format"

interface SubeditionSibling {
  external_id: string
  subedition_id: number | null
  subedition_name: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
  confidence: string | null
  is_self: boolean
}

const PILL_BASE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 999,
  fontFamily: "var(--font-display)",
  fontWeight: 700,
  fontSize: 13,
  letterSpacing: "0.03em",
  textDecoration: "none",
  border: "1px solid var(--rpc-border)",
  color: "var(--rpc-text-secondary)",
  whiteSpace: "nowrap",
}

const PILL_ACTIVE: React.CSSProperties = {
  ...PILL_BASE,
  color: "var(--rpc-red)",
  borderColor: "var(--rpc-red-border, var(--rpc-red))",
  background: "var(--rpc-red-bg, rgba(224,58,47,0.08))",
}

function circ(n: number | null): React.ReactNode {
  return n != null ? (
    <span className="rpc-mono" style={{ fontSize: 10, fontWeight: 400, opacity: 0.85 }}>/{fmtCount(n)}</span>
  ) : null
}

// Premium chip (parallel FMV vs the Standard printing). Muted so it complements
// the pill without competing with the printing name. Only meaningful multiples
// (>= 1.3x) render, so near-parity printings stay clean.
function premiumChip(mult: number | null): React.ReactNode {
  if (!isPremiumShown(mult)) return null
  return (
    <span className="rpc-mono" style={{ fontSize: 10, fontWeight: 700, color: "var(--rpc-red)", opacity: 0.9 }}>
      {fmtMult(mult)}
    </span>
  )
}

export default function ParallelTierSwitcher({
  collection,
  siblings,
}: {
  collection: string
  siblings: SubeditionSibling[]
}) {
  if (!siblings || siblings.length < 2) return null

  // The Standard printing (no subedition_name) is the premium denominator.
  const baseFmv = siblingBaseFmv(siblings)
  const premiumOf = (s: SubeditionSibling): number | null => premiumMultiple(s, baseFmv)

  const anyPremium = hasAnyPremium(siblings)

  return (
    <section aria-label="Parallel printings" style={{ marginTop: 14 }}>
      <div className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 8 }}>
        Parallel printing
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {siblings.map((s) => {
          const name = pillName(s)
          const mult = premiumOf(s)
          if (s.is_self) {
            return (
              <span key={s.external_id} aria-current="true" style={PILL_ACTIVE}>
                {name}
                {circ(s.circulation_count)}
                {premiumChip(mult)}
              </span>
            )
          }
          return (
            <Link
              key={s.external_id}
              href={`/${collection}/edition/${encodeURIComponent(s.external_id)}`}
              prefetch
              style={PILL_BASE}
            >
              {name}
              {circ(s.circulation_count)}
              {premiumChip(mult)}
            </Link>
          )
        })}
      </div>
      {anyPremium && (
        <div style={{ marginTop: 8 }}>
          <Link
            href="/insights/parallel-premiums"
            className="rpc-mono"
            style={{ fontSize: 10, letterSpacing: "0.06em", color: "var(--rpc-text-muted)", textDecoration: "none" }}
          >
            × = premium vs Standard · compare all parallel premiums →
          </Link>
        </div>
      )}
    </section>
  )
}
