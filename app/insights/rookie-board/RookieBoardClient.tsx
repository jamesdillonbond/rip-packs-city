"use client"

// app/insights/rookie-board/RookieBoardClient.tsx
//
// Client interactivity for the public Rookie Edition Board. The server component
// (page.tsx) fetches the whole board (~431 rows) and passes it as initialRows,
// so the grouped per-parallel tables + drill-down links render in the raw server
// HTML (crawlable). This component layers the Board/Burn view toggle and the
// tier/parallel filters on top, filtering in-memory (the dataset is small).
//
// HONESTY CONTRACT (load-bearing): has_full_economics=false rows are PARALLEL
// (::subID) editions — they carry FMV + circulation ONLY. ask/avg/offer/burned/
// locked are NULL by definition and render "—", never $0. Only base (Standard)
// rows show the full economics columns. The per-parallel FMV + confidence tag is
// the differentiator vs the competitor's single blended average per moment.

import { useMemo, useState } from "react"
import Link from "next/link"
import type { RookieEditionRow as Row } from "@/lib/rookie-edition-board"
import { PARALLEL_ORDER } from "@/lib/rookie-edition-board"

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

// Confidence color reuses existing tokens (no new hex). HIGH green, MEDIUM
// indigo, LOW amber, everything else muted — so a $1,794 LOW reads honestly
// next to a $389 HIGH.
function confColor(c: string | null): string {
  switch ((c ?? "").toUpperCase()) {
    case "HIGH":
      return "var(--tier-fandom)"
    case "MEDIUM":
      return "var(--tier-rare)"
    case "LOW":
      return "var(--rpc-warning)"
    default:
      return "var(--rpc-text-muted)"
  }
}

function editionHref(r: Row): string {
  if (r.external_id) return `/nba-top-shot/edition/${encodeURIComponent(r.external_id)}`
  return "#"
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

function ConfChip({ c }: { c: string | null }) {
  if (!c) return null
  return (
    <span className="rpc-rb-conf" style={{ color: confColor(c), borderColor: confColor(c) }}>
      {c.toUpperCase()}
    </span>
  )
}

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
        <ConfChip c={r.fmv_confidence} />
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

type SetGroup = { setName: string; tier: string | null; series: number | null; rows: Row[]; topFmv: number }
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
          <div className="rpc-rb-set" key={`${g.player}-${s.setName}`}>
            <div className="rpc-rb-set-head">
              <div className="rpc-rb-set-art">
                <EdImage r={hero} className="rpc-rb-img" />
              </div>
              <div className="rpc-rb-set-title">
                <div className="rpc-rb-set-name">{s.setName}</div>
                <div className="rpc-rb-set-sub">
                  <span style={{ color: tierColor(s.tier) }}>{normalizeTier(s.tier) ?? "—"}</span>
                  {s.series != null ? (
                    <>
                      <span className="rpc-rb-dot">·</span>
                      <span>Series {s.series}</span>
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
          <span style={{ color: tierColor(r.tier) }}>{normalizeTier(r.tier)}</span>
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
  initialFetchedAt: string | null
}

export default function RookieBoardClient({ initialRows, initialFetchedAt }: Props) {
  const [view, setView] = useState<ViewMode>("board")
  const [tier, setTier] = useState<TierFilter>("all")
  const [parallel, setParallel] = useState<ParallelFilter>("all")

  const rows = initialRows

  // Filter once; both views read the filtered set.
  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (tier !== "all" && normalizeTier(r.tier) !== tier) return false
      if (parallel === "standard" && (r.parallel_id ?? 0) !== 0) return false
      if (parallel === "parallels" && (r.parallel_id ?? 0) === 0) return false
      return true
    })
  }, [rows, tier, parallel])

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
      const bySet = new Map<string, Row[]>()
      for (const r of prows) {
        const s = r.set_name || "—"
        if (!bySet.has(s)) bySet.set(s, [])
        bySet.get(s)!.push(r)
      }
      const sets: SetGroup[] = []
      for (const [setName, srows] of bySet) {
        const sorted = [...srows].sort((a, b) => parallelSort(a) - parallelSort(b))
        const topFmv = srows.reduce((m, r) => Math.max(m, Number(r.fmv_usd ?? 0)), 0)
        // Standard FMV anchors the set's ranking; fall back to its top printing.
        const std = srows.find((r) => (r.parallel_id ?? 0) === 0)
        const anchor = Number(std?.fmv_usd ?? topFmv)
        sets.push({ setName, tier: sorted[0]?.tier ?? null, series: sorted[0]?.series_number ?? null, rows: sorted, topFmv: anchor })
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
    const players = new Set(filtered.map((r) => r.player_name)).size
    const parallels = new Set(filtered.map((r) => r.parallel_name)).size
    const topChase = chases.length ? Number(chases[0].fmv_usd) : null
    return { players, parallels, topChase }
  }, [filtered, chases])

  const shareUrl = `${SITE_URL}/insights/rookie-board`
  const tweetIntent = useMemo(() => {
    const text =
      "Every 2025 Top Shot rookie edition broken out by parallel — per-parallel FMV with a confidence tag, plus burn and lock rates.\n\nRookie Board:"
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`
  }, [shareUrl])
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
          Every 2025 NBA Top Shot rookie edition broken out by <strong>parallel</strong> — Standard,
          Hexwave, Jukebox, Galactic, Omega — each with its own <strong>FMV and a confidence tag</strong>,
          circulation, ask, burn and lock rate. One blended average per moment hides that a Standard sells
          for $389 while its Jukebox prints $1,794.
        </p>
        <div className="rpc-rb-meta-row">
          <span className="rpc-rb-meta">
            Updated{" "}
            {initialFetchedAt
              ? new Date(initialFetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
              : "—"}
          </span>
          <span className="rpc-rb-meta-sep">·</span>
          <span className="rpc-rb-meta">NBA Top Shot · 2025 class</span>
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
                    <ConfChip c={r.fmv_confidence} />
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
            <span className="rpc-rb-pdot" aria-hidden /> <strong>Parallel</strong> printings (Hexwave,
            Jukebox, Galactic, Omega…) show FMV + mint count only. Ask, avg sale, top offer, burn and lock
            are tracked on <strong>Standard</strong> editions — parallels read “—”, not $0.
          </p>
          {playerGroups.length === 0 ? (
            <div className="rpc-rb-state">No rookie editions match those filters.</div>
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
            <div className="rpc-rb-state">No burned rookie editions match those filters.</div>
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
            The 2025 NBA Top Shot rookie class, every edition split out by <strong>parallel</strong> rather
            than rolled into one number. Each printing carries its own <strong>fair market value</strong> with
            a <strong>confidence tag</strong> (HIGH / MEDIUM / LOW / STALE), so you can see exactly how much a
            Hexwave or Jukebox commands over the Standard.
          </p>
          <p>
            FMV and circulation come from RPC&apos;s own indexer for every printing. Ask, average sale, top
            offer, <strong>burn</strong> and <strong>lock</strong> rates are tracked on the Standard editions
            (the on-chain badge data is base-only); parallel rows show “—” for those, never a fake $0. Click
            any printing for its full edition page.
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
.rpc-rb-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-rb-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-rb-lede { font-family: var(--font-body); font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 880px; margin: 0 0 16px; }
.rpc-rb-lede strong { color: var(--rpc-text-primary); }
.rpc-rb-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-rb-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-rb-kpi-row { max-width: 1180px; margin: 0 auto 26px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.rpc-rb-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-rb-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-rb-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--rpc-red); letter-spacing: 0.5px; }

.rpc-rb-section-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 12px; }
.rpc-rb-hero-strip { max-width: 1180px; margin: 0 auto 30px; }
.rpc-rb-hero-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }
.rpc-rb-hero-tile { display: flex; flex-direction: column; text-decoration: none; color: inherit; border: 1px solid var(--rpc-red-border); background: var(--rpc-surface); border-radius: 4px; overflow: hidden; transition: border-color 120ms, transform 120ms, background 120ms; }
.rpc-rb-hero-tile:hover { border-color: var(--rpc-red); background: var(--rpc-surface-hover); transform: translateY(-2px); }
.rpc-rb-hero-art { position: relative; aspect-ratio: 1 / 1; background: var(--rpc-surface-raised); }
.rpc-rb-hero-serial { position: absolute; top: 8px; left: 8px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; padding: 4px 8px; background: var(--rpc-black); border: 1px solid var(--rpc-border); border-radius: 2px; color: var(--rpc-text-secondary); }
.rpc-rb-hero-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 4px; flex: 1; }
.rpc-rb-hero-fmv { font-family: var(--font-display); font-weight: 800; font-size: 24px; color: var(--rpc-red); letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px; }
.rpc-rb-hero-name { font-family: var(--font-body); font-weight: 700; font-size: 15px; line-height: 1.2; color: var(--rpc-text-primary); }
.rpc-rb-hero-set { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.5px; color: var(--rpc-text-muted); line-height: 1.3; }
.rpc-rb-dot { color: var(--rpc-text-ghost); }

.rpc-rb-controls { max-width: 1180px; margin: 0 auto 20px; display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; }
.rpc-rb-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-rb-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-rb-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms, background 120ms; }
.rpc-rb-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-rb-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }

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
.rpc-rb-brow-big { font-family: var(--font-display); font-weight: 800; font-size: 22px; color: var(--rpc-red); letter-spacing: 0.5px; }
.rpc-rb-brow-big2 { font-family: var(--font-mono); font-size: 14px; color: var(--rpc-text-primary); font-weight: 700; }
.rpc-rb-brow-cap { font-family: var(--font-mono); font-size: 9px; letter-spacing: 1px; text-transform: uppercase; color: var(--rpc-text-muted); margin-top: 2px; }

.rpc-rb-footer { max-width: 1180px; margin: 40px auto 0; padding-top: 24px; border-top: 1px solid var(--rpc-border-subtle); display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-rb-method h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-rb-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-rb-method strong { color: var(--rpc-text-primary); }
.rpc-rb-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-rb-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; transition: background 120ms; }
.rpc-rb-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-rb-copy-btn { display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--rpc-text-primary); border: 1px solid var(--rpc-border); font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; cursor: pointer; transition: border-color 120ms, color 120ms; }
.rpc-rb-copy-btn:hover { border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-rb-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-rb-back:hover { color: var(--rpc-red); }

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
