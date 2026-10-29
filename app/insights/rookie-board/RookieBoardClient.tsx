"use client"

// app/insights/rookie-board/RookieBoardClient.tsx
//
// Client interactivity for the public Rookie Edition Board. The server component
// (page.tsx) fetches the whole board (both rookie classes, ~560 rows; a CLASS tab
// filters it, default 2025) and passes it as initialRows,
// so the grouped per-parallel tables + drill-down links render in the raw server
// HTML (crawlable). This component layers the Board/Burn view toggle and the
// tier/parallel filters on top, filtering in-memory (the dataset is small).
//
// HONESTY CONTRACT (load-bearing): has_full_economics=false rows have no badge
// row for that printing — FMV + circulation ONLY; ask/avg/offer/burned/locked are
// NULL and render "—", never $0. (Until badge data went per-parallel this meant
// "every parallel"; read 2026-10-22, all 336 rookie parallels have their own.) The per-parallel FMV is the differentiator
// vs the competitor's single blended average per moment. (The public copy used to
// advertise a "confidence tag" alongside it; that named an internal enum and came
// off 2026-08-01 under the standing no-confidence-UI policy — the tag was never
// rendered in the table anyway, only promised in the prose.)

import { useMemo, useState } from "react"
import { sectionEmptyCopy } from "@/lib/entity/section-empty-copy"
import Link from "next/link"
import { FreshnessStamp } from "@/components/insights/FreshnessStamp"
import type { RookieEditionRow as Row } from "@/lib/rookie-edition-board"
import { PARALLEL_ORDER, ROOKIE_CLASSES, type RookieClass } from "@/lib/rookie-edition-board"
import { rookieBoardShareUrl } from "@/lib/rookie-class-link"
import { useRookieClassParam } from "@/lib/use-rookie-class-param"
import { usdSignFirst } from "@/lib/usd-format"
import { accentText } from "@/lib/accent-text"
// Top Shot only — the raw on-chain series read "Series 8" beside every other surface's "Series 2025-26" (2026-10-25).
import { seriesDisplay } from "@/lib/series-label"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

type ViewMode = "board" | "burn"
type TierFilter = "all" | "COMMON" | "RARE" | "FANDOM" | "LEGENDARY" | "ULTIMATE"
type ParallelFilter = "all" | "standard" | "parallels"

const TIERS: { val: TierFilter; label: string }[] = [
  { val: "all", label: "All" },
  { val: "COMMON", label: "Common" },
  { val: "FANDOM", label: "Fandom" },
  { val: "RARE", label: "Rare" },
  { val: "LEGENDARY", label: "Legendary" },
  { val: "ULTIMATE", label: "Ultimate" },
]
const PARALLELS: { val: ParallelFilter; label: string }[] = [
  { val: "all", label: "All" },
  { val: "standard", label: "Standard" },
  { val: "parallels", label: "Parallels only" },
]

function normalizeTier(t: string | null): string | null {
  if (!t) return null
  return t.replace(/^MOMENT_TIER_/, "")
}

function fmtMoney(n: number | null): string {
  const neg = usdSignFirst(n, fmtMoney); if (neg !== null) return neg
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}

function fmtInt(n: number | null): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

function fmtPct(n: number | null): string {
  if (n == null) return "—"
  return `${Number(n).toFixed(1)}%`
}

function tierColor(tier: string | null): string {
  switch (normalizeTier(tier)) {
    case "LEGENDARY":
      return "var(--tier-legendary)"
    case "ULTIMATE":
      return "var(--tier-ultimate)"
    case "RARE":
      return "var(--tier-rare)"
    case "FANDOM":
      return "var(--tier-fandom)"
    case "COMMON":
      return "var(--tier-common)"
    default:
      return "var(--rpc-text-muted)"
  }
}

// confColor removed with ConfChip 2026-07-11.

function editionHref(r: Row): string {
  if (r.external_id) return `/nba-top-shot/edition/${encodeURIComponent(r.external_id)}`
  return "#"
}

/** The moment a printing belongs to: its `set:play`, without the `::subedition` suffix. */
function momentKey(r: Row): string {
  return r.external_id ? r.external_id.split("::")[0] : `?${r.parallel_id ?? 0}`
}

function parallelSort(r: Row): number {
  const id = r.parallel_id ?? 0
  return PARALLEL_ORDER[id] ?? 99
}

function EdImage({ r, className }: { r: Row; className: string }) {
  const [src, setSrc] = useState<string | null>(r.thumbnail_url)
  const title = r.player_name || r.set_name || "Moment"
  if (!src) return <div className="rpc-rb-img-fallback" aria-hidden />
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={title} className={className} loading="lazy" onError={() => setSrc(null)} />
  )
}

// ConfChip removed 2026-07-11 — confidence tiers are build-time signal, not
// front-end content.

// One parallel row inside a set table. Full-economics columns render "—" for
// parallel rows by contract.
function ParallelRow({ r }: { r: Row }) {
  return (
    <Link href={editionHref(r)} className="rpc-rb-prow">
      <div className="rpc-rb-pcell rpc-rb-pname">
        <span className="rpc-rb-pdot" aria-hidden />
        {r.parallel_name || "Standard"}
      </div>
      <div className="rpc-rb-pcell rpc-rb-fmv">
        <span className="rpc-rb-fmv-val">{fmtMoney(r.fmv_usd)}</span>
      </div>
      <div className="rpc-rb-pcell rpc-rb-num">/ {fmtInt(r.circulation_count)}</div>
      <div className="rpc-rb-pcell rpc-rb-num">{fmtMoney(r.low_ask)}</div>
      <div className="rpc-rb-pcell rpc-rb-num">{fmtMoney(r.avg_sale_price)}</div>
      <div className="rpc-rb-pcell rpc-rb-num">{fmtMoney(r.highest_offer)}</div>
      <div className="rpc-rb-pcell rpc-rb-num">
        {r.has_full_economics ? `${fmtInt(r.burned)} · ${fmtPct(r.burn_rate_pct)}` : "—"}
      </div>
      <div className="rpc-rb-pcell rpc-rb-num">
        {r.has_full_economics ? fmtPct(r.lock_rate_pct) : "—"}
      </div>
    </Link>
  )
}

type SetGroup = { key: string; setName: string; tier: string | null; series: number | null; rows: Row[]; topFmv: number }
type PlayerGroup = { player: string; sets: SetGroup[]; topFmv: number; editionCount: number }

function PlayerCard({ g }: { g: PlayerGroup }) {
  return (
    <section className="rpc-rb-player">
      <div className="rpc-rb-player-head">
        <h2 className="rpc-rb-player-name">{g.player}</h2>
        <div className="rpc-rb-player-meta">
          <span>{fmtInt(g.editionCount)} editions</span>
          <span className="rpc-rb-dot">·</span>
          <span>top {fmtMoney(g.topFmv)}</span>
        </div>
      </div>
      {g.sets.map((s) => {
        const hero = s.rows[0]
        return (
          <div className="rpc-rb-set" key={`${g.player}-${s.key}`}>
            <div className="rpc-rb-set-head">
              <div className="rpc-rb-set-art">
                <EdImage r={hero} className="rpc-rb-img" />
              </div>
              <div className="rpc-rb-set-title">
                <div className="rpc-rb-set-name">{s.setName}</div>
                <div className="rpc-rb-set-sub">
                  <span style={{ color: accentText(tierColor(s.tier)) }}>{normalizeTier(s.tier) ?? "—"}</span>
                  {s.series != null ? (
                    <>
                      <span className="rpc-rb-dot">·</span>
                      <span>{seriesDisplay(s.series, "nba-top-shot")}</span>
                    </>
                  ) : null}
                  <span className="rpc-rb-dot">·</span>
                  <span>{s.rows.length} printing{s.rows.length === 1 ? "" : "s"}</span>
                </div>
              </div>
            </div>
            <div className="rpc-rb-ptable">
              <div className="rpc-rb-phead">
                <div className="rpc-rb-pcell rpc-rb-pname">Printing</div>
                <div className="rpc-rb-pcell rpc-rb-fmv">FMV</div>
                <div className="rpc-rb-pcell rpc-rb-num">Mint</div>
                <div className="rpc-rb-pcell rpc-rb-num">Ask</div>
                <div className="rpc-rb-pcell rpc-rb-num">Avg sale</div>
                <div className="rpc-rb-pcell rpc-rb-num">Top offer</div>
                <div className="rpc-rb-pcell rpc-rb-num">Burned</div>
                <div className="rpc-rb-pcell rpc-rb-num">Lock</div>
              </div>
              {s.rows.map((r) => (
                <ParallelRow key={r.external_id} r={r} />
              ))}
            </div>
          </div>
        )
      })}
    </section>
  )
}

function BurnRow({ r, rank }: { r: Row; rank: number }) {
  return (
    <Link href={editionHref(r)} className="rpc-rb-brow">
      <div className="rpc-rb-rank">{rank}</div>
      <div className="rpc-rb-brow-art">
        <EdImage r={r} className="rpc-rb-img" />
      </div>
      <div className="rpc-rb-brow-main">
        <div className="rpc-rb-brow-name">{r.player_name || "—"}</div>
        <div className="rpc-rb-brow-sub">
          <span>{r.set_name}</span>
          <span className="rpc-rb-dot">·</span>
          <span style={{ color: accentText(tierColor(r.tier)) }}>{normalizeTier(r.tier)}</span>
          <span className="rpc-rb-dot">·</span>
          <span>/ {fmtInt(r.circulation_count)}</span>
        </div>
      </div>
      <div className="rpc-rb-brow-stat">
        <div className="rpc-rb-brow-big">{fmtInt(r.burned)}</div>
        <div className="rpc-rb-brow-cap">burned · {fmtPct(r.burn_rate_pct)}</div>
      </div>
      <div className="rpc-rb-brow-stat rpc-rb-hide-sm">
        <div className="rpc-rb-brow-big2">{fmtPct(r.lock_rate_pct)}</div>
        <div className="rpc-rb-brow-cap">locked</div>
      </div>
      <div className="rpc-rb-brow-stat rpc-rb-hide-sm">
        <div className="rpc-rb-brow-big2">{fmtInt(r.effective_supply)}</div>
        <div className="rpc-rb-brow-cap">effective</div>
      </div>
      <div className="rpc-rb-brow-stat">
        <div className="rpc-rb-brow-big2">{fmtMoney(r.fmv_usd)}</div>
        <div className="rpc-rb-brow-cap">FMV</div>
      </div>
    </Link>
  )
}

type Props = {
  initialRows: Row[]
  /**
   * ⚠ TRUE when the SERVER read failed. This client NEVER refetches — `rows` is
   * `initialRows`, with no state and no effect — so an unlabelled `[]` made the
   * board say "No rookie editions match those filters." for the whole visit.
   */
  initialFailed?: boolean
  initialFetchedAt: string | null
}

export default function RookieBoardClient({ initialRows, initialFetchedAt, initialFailed = false }: Props) {
  const [view, setView] = useState<ViewMode>("board")
  const [tier, setTier] = useState<TierFilter>("all")
  const [parallel, setParallel] = useState<ParallelFilter>("all")
  // 2026-10-23: `?class=2026` on the PAGE URL opens that tab. The URL is read as
  // an external store (null on the server and at hydration — the page is ISR, so
  // the server cannot read the query); a tab click overrides it.
  const urlClass = useRookieClassParam(ROOKIE_CLASSES) as RookieClass | null
  const [pickedClass, setCls] = useState<RookieClass | null>(null)
  const cls: RookieClass = pickedClass ?? urlClass ?? "2025"

  const rows = initialRows

  // Filter once; both views read the filtered set.
  const filtered = useMemo(() => {
    return rows.filter((r) => {
      // A row with no class predates the 2026 class (every such row was 2025).
      if ((r.rookie_class ?? "2025") !== cls) return false
      if (tier !== "all" && normalizeTier(r.tier) !== tier) return false
      if (parallel === "standard" && (r.parallel_id ?? 0) !== 0) return false
      if (parallel === "parallels" && (r.parallel_id ?? 0) === 0) return false
      return true
    })
  }, [rows, tier, parallel, cls])

  // Top chases: highest-FMV editions across the (filtered) board, parallels
  // included — the Galactic/Omega chases are the headline grails.
  const chases = useMemo(() => {
    return [...filtered]
      .filter((r) => r.fmv_usd != null)
      .sort((a, b) => Number(b.fmv_usd) - Number(a.fmv_usd))
      .slice(0, 5)
  }, [filtered])

  // Board grouping: player → set → parallel rows.
  const playerGroups = useMemo<PlayerGroup[]>(() => {
    const byPlayer = new Map<string, Row[]>()
    for (const r of filtered) {
      const p = r.player_name || "—"
      if (!byPlayer.has(p)) byPlayer.set(p, [])
      byPlayer.get(p)!.push(r)
    }
    const groups: PlayerGroup[] = []
    for (const [player, prows] of byPlayer) {
      // One block per MOMENT, not per set name (2026-10-29): a printing is the same
      // set:play under another subedition (`241:8449` vs `241:8449::21`). Keyed on set
      // name alone, Kon Knueppel's five different Signature Series /1s read as
      // "5 printings", each labelled "Standard".
      const bySet = new Map<string, { setName: string; rows: Row[] }>()
      for (const r of prows) {
        const setName = r.set_name || "—"
        const key = `${setName}|${momentKey(r)}`
        if (!bySet.has(key)) bySet.set(key, { setName, rows: [] })
        bySet.get(key)!.rows.push(r)
      }
      const sets: SetGroup[] = []
      for (const [key, { setName, rows: srows }] of bySet) {
        const sorted = [...srows].sort((a, b) => parallelSort(a) - parallelSort(b))
        const topFmv = srows.reduce((m, r) => Math.max(m, Number(r.fmv_usd ?? 0)), 0)
        // Standard FMV anchors the set's ranking; fall back to its top printing.
        const std = srows.find((r) => (r.parallel_id ?? 0) === 0)
        const anchor = Number(std?.fmv_usd ?? topFmv)
        sets.push({ key, setName, tier: sorted[0]?.tier ?? null, series: sorted[0]?.series_number ?? null, rows: sorted, topFmv: anchor })
      }
      sets.sort((a, b) => b.topFmv - a.topFmv)
      const topFmv = prows.reduce((m, r) => Math.max(m, Number(r.fmv_usd ?? 0)), 0)
      groups.push({ player, sets, topFmv, editionCount: prows.length })
    }
    groups.sort((a, b) => b.topFmv - a.topFmv)
    return groups
  }, [filtered])

  // Burn rankings: base editions with real burn data, most burned first.
  const burnRows = useMemo(() => {
    return filtered
      .filter((r) => r.has_full_economics && (r.burned ?? 0) > 0)
      .sort((a, b) => Number(b.burned ?? 0) - Number(a.burned ?? 0))
      .slice(0, 60)
  }, [filtered])

  const kpis = useMemo(() => {
    // ⛔ A FAILED READ HAS NO KPIs (deep-audit 2026-09-18 §2, P0; the same
    // defect the top-sales/squeeze fix closed). Under this board's own banner —
    // "treat the affected sections as unknown rather than zero" — the strip
    // printed measured-looking zeros. ⚠ Keyed on PROVENANCE, never on
    // rows.length: a read that SUCCEEDED and matched nothing genuinely IS 0 and
    // must keep saying so. The bug is the missing THIRD state, not the zero.
    // `topChase` was already honest (null when nothing is priced) beside two
    // fabricated counts — the per-VALUE tell. This board never refetches, so the
    // seed's `initialFailed` is the provenance for the whole visit.
    if (initialFailed) return { players: null, parallels: null, topChase: null }
    const players = new Set(filtered.map((r) => r.player_name)).size
    const parallels = new Set(filtered.map((r) => r.parallel_name)).size
    const topChase = chases.length ? Number(chases[0].fmv_usd) : null
    return { players, parallels, topChase }
  }, [filtered, chases, initialFailed])

  const shareUrl = rookieBoardShareUrl(`${SITE_URL}/insights/rookie-board`, cls)
  const tweetIntent = useMemo(() => {
    const text =
      `Every ${cls} Top Shot rookie edition broken out by parallel — per-parallel FMV, plus burn and lock rates.\n\nRookie Board:`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`
  }, [shareUrl, cls])
  const [copied, setCopied] = useState(false)
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard can be blocked — non-fatal */
    }
  }

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-rb-head">
        <div className="rpc-rb-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-rb-h1">Rookie Board</h1>
        <p className="rpc-rb-lede">
          {/* "confidence tag" named an internal scoring enum a visitor cannot
              calibrate — the standing no-confidence-UI policy. The differentiator
              is the per-parallel split itself, so say that. (2026-08-01)
              2026-10-20: the "$389 Standard vs $1,794 Jukebox" example was a typed-in
              sample from an old dataset; no row on the page showed either price. */}
          Every {cls} NBA Top Shot rookie edition broken out by <strong>parallel</strong> — Standard,
          Hexwave, Jukebox, Galactic, Omega — each with its <strong>own FMV</strong>,
          circulation, ask, burn and lock rate. One blended average per moment hides how far apart
          the parallels of the same Moment trade.
        </p>
        <div className="rpc-rb-meta-row">
          <span className="rpc-rb-meta">
            {/* ⚠ R95: the stamp must never vouch for a failed read. The page now
                passes null on failure, and this is the second lock — a refetch
                that fails after mount leaves the old stamp in state otherwise. */}
            Updated <FreshnessStamp iso={initialFailed ? null : initialFetchedAt} />
          </span>
          <span className="rpc-rb-meta-sep">·</span>
          <span className="rpc-rb-meta">NBA Top Shot · {cls} class</span>
          <span className="rpc-rb-meta-sep">·</span>
          <span className="rpc-rb-meta">No signup</span>
        </div>
      </section>

      <section className="rpc-rb-kpi-row" aria-label="Summary">
        <div className="rpc-rb-kpi">
          <div className="rpc-rb-kpi-label">Rookies tracked</div>
          <div className="rpc-rb-kpi-value">{fmtInt(kpis.players)}</div>
        </div>
        <div className="rpc-rb-kpi">
          <div className="rpc-rb-kpi-label">Parallels</div>
          <div className="rpc-rb-kpi-value">{fmtInt(kpis.parallels)}</div>
        </div>
        <div className="rpc-rb-kpi">
          <div className="rpc-rb-kpi-label">Top chase FMV</div>
          <div className="rpc-rb-kpi-value">{fmtMoney(kpis.topChase)}</div>
        </div>
      </section>

      {chases.length > 0 ? (
        <section className="rpc-rb-hero-strip" aria-label="Top chases">
          <div className="rpc-rb-section-label">Featured · top chases</div>
          <div className="rpc-rb-hero-grid">
            {chases.map((r) => (
              <Link href={editionHref(r)} className="rpc-rb-hero-tile" key={r.external_id}>
                <div className="rpc-rb-hero-art">
                  <EdImage r={r} className="rpc-rb-img" />
                  <span className="rpc-rb-hero-serial">/ {fmtInt(r.circulation_count)}</span>
                </div>
                <div className="rpc-rb-hero-body">
                  <div className="rpc-rb-hero-fmv">
                    {fmtMoney(r.fmv_usd)}
                  </div>
                  <div className="rpc-rb-hero-name">{r.player_name}</div>
                  <div className="rpc-rb-hero-set">
                    {r.set_name} · {r.parallel_name}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rpc-rb-controls" aria-label="Filters">
        <div className="rpc-rb-pill-group" role="tablist" aria-label="Rookie class">
          <span className="rpc-rb-pill-label">CLASS</span>
          {ROOKIE_CLASSES.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={cls === c}
              className={`rpc-rb-pill ${cls === c ? "rpc-rb-pill-active" : ""}`}
              onClick={() => setCls(c)}
            >
              {c} class
            </button>
          ))}
        </div>

        <div className="rpc-rb-pill-group" role="tablist" aria-label="View">
          <span className="rpc-rb-pill-label">VIEW</span>
          <button
            role="tab"
            aria-selected={view === "board"}
            className={`rpc-rb-pill ${view === "board" ? "rpc-rb-pill-active" : ""}`}
            onClick={() => setView("board")}
          >
            Board
          </button>
          <button
            role="tab"
            aria-selected={view === "burn"}
            className={`rpc-rb-pill ${view === "burn" ? "rpc-rb-pill-active" : ""}`}
            onClick={() => setView("burn")}
          >
            Burn Rankings
          </button>
        </div>

        <div className="rpc-rb-pill-group" role="tablist" aria-label="Tier">
          <span className="rpc-rb-pill-label">TIER</span>
          {TIERS.map((t) => (
            <button
              key={t.val}
              role="tab"
              aria-selected={tier === t.val}
              className={`rpc-rb-pill ${tier === t.val ? "rpc-rb-pill-active" : ""}`}
              onClick={() => setTier(t.val)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {view === "board" ? (
          <div className="rpc-rb-pill-group" role="tablist" aria-label="Printing">
            <span className="rpc-rb-pill-label">PRINTING</span>
            {PARALLELS.map((p) => (
              <button
                key={p.val}
                role="tab"
                aria-selected={parallel === p.val}
                className={`rpc-rb-pill ${parallel === p.val ? "rpc-rb-pill-active" : ""}`}
                onClick={() => setParallel(p.val)}
              >
                {p.label}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {view === "board" ? (
        <section className="rpc-rb-board" aria-label="Rookie editions by parallel">
          <p className="rpc-rb-honesty">
            {/* 2026-10-29: this said parallels "show FMV + mint count only … read —", true until badge
                data went per-parallel (all 336 rookie parallels had their own by 10-22, header above),
                while the rows beside it showed a Galactic's own ask, sale, offer and lock. */}
            <span className="rpc-rb-pdot" aria-hidden /> Every printing, the <strong>Standard</strong> and
            each <strong>parallel</strong> (Hexwave, Jukebox, Galactic, Omega…), carries its own FMV, ask,
            avg sale, top offer, burn and lock. A printing with no data for one of them reads “—”, not $0.
          </p>
          {playerGroups.length === 0 ? (
            <div className="rpc-rb-state">
              {/* ⚠ The empty wording is UNCHANGED; only the degraded case is new. */}
              {sectionEmptyCopy(!initialFailed, "Rookie editions", "No rookie editions match those filters.")}
            </div>
          ) : (
            playerGroups.map((g) => <PlayerCard key={g.player} g={g} />)
          )}
        </section>
      ) : (
        <section className="rpc-rb-burn" aria-label="Burn rankings">
          <p className="rpc-rb-honesty">
            Ranked by moments <strong>burned</strong> (sent to the null address — permanently destroyed),
            most-burned first. Burn data exists on <strong>Standard</strong> editions only. Effective supply
            = circulation − burned − locked.
          </p>
          {burnRows.length === 0 ? (
            <div className="rpc-rb-state">
              {/* ⚠ THE SECOND PANEL. Found only when the deployed HTML was checked:
                  the burn view reads the SAME `initialRows`, so a failed seed made
                  it blame the filters too. "Fix per PANEL, not per page." */}
              {sectionEmptyCopy(
                !initialFailed,
                "Burned rookie editions",
                "No burned rookie editions match those filters.",
              )}
            </div>
          ) : (
            <div className="rpc-rb-blist">
              {burnRows.map((r, i) => (
                <BurnRow key={r.external_id} r={r} rank={i + 1} />
              ))}
            </div>
          )}
        </section>
      )}

      <section className="rpc-rb-footer">
        <div className="rpc-rb-method">
          <h3 className="rpc-rb-h3">What this board is</h3>
          <p>
            The {cls} NBA Top Shot rookie class, every edition split out by <strong>parallel</strong> rather
            than rolled into one number. Each printing carries its own <strong>fair market value</strong>,
            priced from that printing&apos;s own sales rather than the moment&apos;s blended average, so you
            can see exactly how much a Hexwave or Jukebox commands over the Standard.
          </p>
          <p>
            FMV and circulation come from RPC&apos;s own indexer for every printing. Ask, average sale, top
            offer, <strong>burn</strong> and <strong>lock</strong> rates come from each printing&apos;s own
            on-chain badge data — the Standard and each parallel separately. A printing with no badge data
            shows “—” for those, never a fake $0. Click any printing for its full edition page.
          </p>
        </div>
        <div className="rpc-rb-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-rb-share-btn">
            Share on Twitter
          </a>
          <button type="button" onClick={copyLink} className="rpc-rb-copy-btn">
            {copied ? "Copied!" : "Copy link"}
          </button>
          <Link href="/insights/rookies" className="rpc-rb-back">
            Rookie class index →
          </Link>
          <Link href="/insights" className="rpc-rb-back">
            More public insights →
          </Link>
        </div>
      </section>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "var(--rpc-black)",
    color: "var(--rpc-text-primary)",
    fontFamily: "var(--font-body)",
    padding: "32px 20px 80px",
  },
}

const CSS = `
.rpc-rb-head { max-width: 1180px; margin: 0 auto 24px; padding-bottom: 22px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-rb-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red-text); margin-bottom: 12px; }
.rpc-rb-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-rb-lede { font-family: var(--font-body); font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 880px; margin: 0 0 16px; }
.rpc-rb-lede strong { color: var(--rpc-text-primary); }
.rpc-rb-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-rb-meta-sep { margin: 0 8px; color: var(--rpc-text-muted); }

.rpc-rb-kpi-row { max-width: 1180px; margin: 0 auto 26px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.rpc-rb-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-rb-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-rb-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--rpc-red-text); letter-spacing: 0.5px; }

.rpc-rb-section-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 12px; }
.rpc-rb-hero-strip { max-width: 1180px; margin: 0 auto 30px; }
.rpc-rb-hero-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
.rpc-rb-hero-tile { display: flex; flex-direction: column; text-decoration: none; color: inherit; border: 1px solid var(--rpc-red-border); background: var(--rpc-surface); border-radius: 4px; overflow: hidden; transition: border-color 120ms, transform 120ms, background 120ms; }
.rpc-rb-hero-tile:hover { border-color: var(--rpc-red); background: var(--rpc-surface-hover); transform: translateY(-2px); }
.rpc-rb-hero-art { position: relative; aspect-ratio: 1 / 1; background: var(--rpc-surface-raised); }
.rpc-rb-hero-serial { position: absolute; top: 8px; left: 8px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; padding: 4px 8px; background: var(--rpc-black); border: 1px solid var(--rpc-border); border-radius: 2px; color: var(--rpc-text-secondary); }
.rpc-rb-hero-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
.rpc-rb-hero-fmv { font-family: var(--font-display); font-weight: 800; font-size: 24px; color: var(--rpc-red-text); letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px; }
.rpc-rb-hero-name { font-family: var(--font-body); font-weight: 700; font-size: 15px; line-height: 1.2; color: var(--rpc-text-primary); }
.rpc-rb-hero-set { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.5px; color: var(--rpc-text-muted); line-height: 1.3; }
.rpc-rb-dot { color: var(--rpc-text-muted); }

.rpc-rb-controls { max-width: 1180px; margin: 0 auto 20px; display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; }
.rpc-rb-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-rb-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-rb-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms, background 120ms; }
.rpc-rb-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-rb-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red-text); }

.rpc-rb-board, .rpc-rb-burn { max-width: 1180px; margin: 0 auto; }
.rpc-rb-honesty { font-family: var(--font-body); font-size: 12.5px; line-height: 1.55; color: var(--rpc-text-muted); margin: 0 0 18px; padding: 10px 14px; border: 1px solid var(--rpc-border-subtle); border-left: 2px solid var(--rpc-warning); background: var(--rpc-surface); border-radius: 2px; }
.rpc-rb-honesty strong { color: var(--rpc-text-secondary); }
.rpc-rb-pdot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; border: 1px solid var(--rpc-warning); vertical-align: middle; }
.rpc-rb-state { padding: 48px 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 2px; }

.rpc-rb-player { margin-bottom: 30px; }
.rpc-rb-player-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding-bottom: 10px; margin-bottom: 12px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-rb-player-name { font-family: var(--font-display); font-weight: 800; font-size: 26px; letter-spacing: 0.5px; text-transform: uppercase; margin: 0; }
.rpc-rb-player-meta { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--rpc-text-muted); display: flex; gap: 8px; white-space: nowrap; }

.rpc-rb-set { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 4px; margin-bottom: 12px; overflow: hidden; }
.rpc-rb-set-head { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); }
.rpc-rb-set-art { width: 44px; height: 44px; border-radius: 3px; overflow: hidden; background: var(--rpc-surface); flex-shrink: 0; }
.rpc-rb-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.rpc-rb-img-fallback { width: 100%; height: 100%; background: linear-gradient(135deg, var(--rpc-surface-raised), var(--rpc-surface)); }
.rpc-rb-set-name { font-family: var(--font-body); font-weight: 700; font-size: 16px; color: var(--rpc-text-primary); }
.rpc-rb-set-sub { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: 1px; text-transform: uppercase; color: var(--rpc-text-muted); display: flex; gap: 6px; margin-top: 2px; }

.rpc-rb-ptable { display: flex; flex-direction: column; }
.rpc-rb-phead, .rpc-rb-prow { display: grid; grid-template-columns: 1.4fr 1.3fr 0.8fr 1fr 1fr 1fr 1.2fr 0.8fr; align-items: center; gap: 8px; padding: 9px 14px; }
.rpc-rb-phead { font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-rb-prow { text-decoration: none; color: inherit; border-bottom: 1px solid var(--rpc-border-subtle); transition: background 120ms; }
.rpc-rb-prow:last-child { border-bottom: none; }
.rpc-rb-prow:hover { background: var(--rpc-surface-hover); }
.rpc-rb-pcell { min-width: 0; font-family: var(--font-mono); font-size: 12.5px; }
.rpc-rb-pname { font-family: var(--font-body); font-weight: 600; font-size: 13.5px; color: var(--rpc-text-primary); display: flex; align-items: center; gap: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rpc-rb-num { color: var(--rpc-text-secondary); text-align: right; white-space: nowrap; }
.rpc-rb-fmv { display: flex; align-items: center; gap: 7px; }
.rpc-rb-fmv-val { font-weight: 700; color: var(--rpc-text-primary); }
.rpc-rb-conf { font-family: var(--font-mono); font-size: 8.5px; letter-spacing: 1px; text-transform: uppercase; padding: 1px 5px; border: 1px solid; border-radius: 2px; white-space: nowrap; }

.rpc-rb-blist { display: flex; flex-direction: column; gap: 8px; }
.rpc-rb-brow { display: grid; grid-template-columns: 32px 52px minmax(0, 1fr) auto auto auto auto; align-items: center; gap: 14px; text-decoration: none; color: inherit; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); border-radius: 4px; padding: 10px 16px 10px 10px; transition: border-color 120ms, background 120ms, transform 120ms; }
.rpc-rb-brow:hover { border-color: var(--rpc-red); background: var(--rpc-surface-hover); transform: translateY(-1px); }
.rpc-rb-rank { font-family: var(--font-mono); font-size: 13px; color: var(--rpc-text-muted); text-align: center; }
.rpc-rb-brow-art { width: 52px; height: 52px; border-radius: 3px; overflow: hidden; background: var(--rpc-surface-raised); }
.rpc-rb-brow-main { min-width: 0; }
.rpc-rb-brow-name { font-family: var(--font-body); font-weight: 700; font-size: 15px; color: var(--rpc-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rpc-rb-brow-sub { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.5px; color: var(--rpc-text-muted); display: flex; flex-wrap: wrap; gap: 6px; margin-top: 3px; }
.rpc-rb-brow-stat { text-align: right; white-space: nowrap; }
.rpc-rb-brow-big { font-family: var(--font-display); font-weight: 800; font-size: 22px; color: var(--rpc-red-text); letter-spacing: 0.5px; }
.rpc-rb-brow-big2 { font-family: var(--font-mono); font-size: 14px; color: var(--rpc-text-primary); font-weight: 700; }
.rpc-rb-brow-cap { font-family: var(--font-mono); font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: var(--rpc-text-muted); margin-top: 2px; }

.rpc-rb-footer { max-width: 1180px; margin: 40px auto 0; padding-top: 24px; border-top: 1px solid var(--rpc-border-subtle); display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-rb-method h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-rb-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-rb-method strong { color: var(--rpc-text-primary); }
.rpc-rb-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-rb-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red-fill); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; transition: background 120ms; }
.rpc-rb-share-btn:hover { background: var(--rpc-red-fill-hover); }
.rpc-rb-copy-btn { display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--rpc-text-primary); border: 1px solid var(--rpc-border); font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; cursor: pointer; transition: border-color 120ms, color 120ms; }
.rpc-rb-copy-btn:hover { border-color: var(--rpc-red); color: var(--rpc-red-text); }
.rpc-rb-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-rb-back:hover { color: var(--rpc-red-text); }

@media (max-width: 1100px) { .rpc-rb-hero-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 860px) {
  .rpc-rb-phead, .rpc-rb-prow { grid-template-columns: 1.3fr 1.2fr 0.7fr 1fr; }
  .rpc-rb-phead .rpc-rb-num:nth-child(n+5), .rpc-rb-prow .rpc-rb-pcell:nth-child(n+5) { display: none; }
}
@media (max-width: 760px) {
  .rpc-rb-hero-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-rb-footer { grid-template-columns: 1fr; }
  .rpc-rb-hide-sm { display: none; }
  .rpc-rb-brow { grid-template-columns: 24px 44px minmax(0, 1fr) auto auto; }
}
`
