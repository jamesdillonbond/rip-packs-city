"use client"

import Link from "next/link"
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { getOwnerKey } from "@/lib/owner-key"
import { fetchSavedWalletForCollection } from "@/lib/profile/saved-wallet-for-collection"
import WalletStatRow from "@/components/wallet-stat-row"
import {
  PINNACLE_VARIANT_COLORS,
  PINNACLE_VARIANT_RANK,
  pinnacleStudioShort,
} from "@/lib/pinnacle/pinnacleTypes"
import { PINNACLE_SERIAL_MIN_MINT } from "@/lib/pinnacle/serial-fmv"
import { usdSignFirst } from "@/lib/usd-format"
import { getCollection } from "@/lib/collections"
import { pinnacleRenderHref } from "@/lib/entity-href"
import { proxyIpfsUrl } from "@/lib/ipfs-media"
import { pickLoading } from "@/lib/schonely"
import IpfsImg from "@/components/media/IpfsImg"

// Pinnacle wallet view — dedicated route so the Top Shot-heavy
// [collection]/collection/page.tsx stays focused on player/team/tier.
// Uses get_wallet_moments_with_fmv (with Pinnacle UUID), plus the three
// Pinnacle-specific header RPCs.

type PinnacleMoment = {
  moment_id: string
  edition_key: string | null
  serial_number: number | null
  player_name: string | null        // character (RPC column names stay generic)
  set_name: string | null
  tier: string | null                // variant
  series_number: number | null
  fmv_usd: number | null
  franchise?: string | null
  studio?: string | null
  variant_type?: string | null
  edition_type?: string | null
  // true / false / null from /api/pinnacle-wallet. null = "cannot say" (unknown
  // edition type), which must fall back to the neutral em-dash rather than
  // asserting the edition has no serials.
  is_serialised?: boolean | null
  mint_count?: number | null
  thumbnail_url?: string | null
  /** Exact `pinnacle_catalog` render — the pin's own page is keyed on it. */
  render_id?: string | null
  low_ask?: number | null
  // Serial-adjusted value from the fitted Pinnacle serial-premium model
  // (lib/pinnacle/serial-fmv.ts, applied in /api/pinnacle-wallet). Null when the
  // model declines to estimate — an unpriced render, a serial with no premium
  // band, an unreliable band, or a mint below the display guard.
  serial_fmv?: number | null
  serial_band?: "first" | "low5" | "low20" | "normal" | null
  serial_mult?: number | null
}

type VariantBucket = { variant_type: string; count: number; total_fmv: number | null }
type FranchiseBucket = { franchise: string; count: number; total_fmv: number | null }

// The registry accent, not a second hardcoded copy of it.
const ACCENT = getCollection("disney-pinnacle")?.accent ?? "var(--rpc-red)"
const PAGE_SIZE = 100

function usd(n: number | null | undefined) {
  const neg = usdSignFirst(n, usd); if (neg !== null) return neg
  if (n == null || !isFinite(Number(n))) return "—"
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Most Disney Pinnacle editions carry no serial numbers at all -- serialisation is
// a property of the edition TYPE (Limited / Limited Event / Legendary / Genesis are
// serialised; Open / Open Event / Starter never are, measured 2026-08-02 across
// 50,755 wallet rows with not one mixed edition). Rendering a bare em-dash for the
// 72% of holdings on unserialised editions read as missing data we had failed to
// index. It is not missing; it does not exist. Say that.
function notSerialisedCell() {
  return (
    <span
      title="This Pinnacle edition type is not serialised — its mints carry no serial numbers. This is not missing data."
      style={{ color: "var(--rpc-text-ghost)", fontStyle: "italic", fontSize: 11 }}
    >
      not serialised
    </span>
  )
}

// Serial-adjusted estimate cell. Shows nothing but an em-dash when the model
// declined to estimate, and shows the plain FMV with no multiplier chip when the
// serial sits in the `normal` band — a "x1.00" badge on 80% of rows would be
// noise, and claiming a premium where the model found none would be worse.
function serialEstCell(m: PinnacleMoment) {
  // No serial exists on this edition type at all, so there is no serial premium
  // to estimate. Saying so beats a second em-dash beside the first.
  if (m.is_serialised === false) return notSerialisedCell()
  if (m.serial_fmv == null) return "—"
  const mult = m.serial_mult ?? 1
  if (m.serial_band === "normal" || mult <= 1.001) {
    return <span style={{ color: "var(--rpc-text-secondary)" }}>{usd(m.serial_fmv)}</span>
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ color: ACCENT, fontWeight: 600 }}>{usd(m.serial_fmv)}</span>
      <span style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>×{mult.toFixed(2)}</span>
    </span>
  )
}

// A variant is shown as a coloured dot + the name in the theme's text colour.
// The old chip painted the NAME in the variant colour, which is unreadable in
// light mode for the pale variants (Golden #FFD700, Brushed Silver #C0C0C0 on
// white) — the dot carries the colour, the text stays legible in both themes.
function variantBadge(variant: string | null | undefined) {
  const v = variant ?? "Standard"
  const color = PINNACLE_VARIANT_COLORS[v] ?? "#6B7280"
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 999,
      fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600, whiteSpace: "nowrap",
      color: "var(--rpc-text-primary)", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)",
    }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: color, flexShrink: 0 }} />
      {v}
    </span>
  )
}

// `set_name` arrives as "<Studio> • <Set>" from get_wallet_moments_with_fmv
// (measured 2026-09-27). The row carries NO `franchise` or `studio` field, so a
// Franchise column read "—" on every row in production; the studio is IN the
// set name, so split it out rather than render a column that is always empty.
export function splitPinnacleSetName(setName: string | null | undefined): { studio: string | null; set: string | null } {
  if (!setName) return { studio: null, set: null }
  const i = setName.indexOf(" • ")
  if (i < 0) return { studio: null, set: setName }
  return { studio: setName.slice(0, i), set: setName.slice(i + 3) || null }
}

/** Where a held pin links on OUR site: its exact render when the row names it. */
function pinHref(m: PinnacleMoment): string | null {
  if (m.render_id) return pinnacleRenderHref(m.render_id)
  if (m.edition_key) return `/pinnacle/moment/${encodeURIComponent(m.edition_key)}`
  return null
}

export default function PinnacleCollectionClient() {
  return (
    <Suspense fallback={<div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", padding: 24 }}>Loading…</div>}>
      <PinnacleCollectionPageInner />
    </Suspense>
  )
}

function PinnacleCollectionPageInner() {
  const router = useRouter()
  const sp = useSearchParams()
  const walletParam = sp?.get("wallet") ?? ""

  const [input, setInput] = useState(walletParam)
  const [activeWallet, setActiveWallet] = useState(walletParam)
  const [rows, setRows] = useState<PinnacleMoment[]>([])
  const [loading, setLoading] = useState(false)
  const [totalFmv, setTotalFmv] = useState<number | null>(null)
  const [momentCount, setMomentCount] = useState<number | null>(0)
  // Pinnacle has no locking concept — null signals "n/a for this collection"
  // to <WalletStatRow>. bestOfferTotal / spreadGap stay null until Pinnacle
  // wallet-scoped offer ingest exists.
  const [unlockedFmv, setUnlockedFmv] = useState<number | null>(null)
  const [unlockedCount, setUnlockedCount] = useState<number | null>(null)
  const [bestOfferTotal, setBestOfferTotal] = useState<number | null>(null)
  const [spreadGap, setSpreadGap] = useState<number | null>(null)
  const [variants, setVariants] = useState<VariantBucket[]>([])
  const [franchises, setFranchises] = useState<FranchiseBucket[]>([])
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(Boolean(walletParam))

  const onSearch = useCallback(() => {
    const w = input.trim()
    if (!w) return
    setActiveWallet(w)
    router.push(`/disney-pinnacle/collection?wallet=${encodeURIComponent(w)}`)
  }, [input, router])

  // Auto-load: when neither URL ?wallet= nor manual input is set but the user
  // is signed in, fall back to ownerKey or the saved Pinnacle wallet so the
  // page populates without requiring a trip to /profile. Only fires once and
  // only when nothing has been typed.
  const autoFiredRef = useRef(false)
  useEffect(() => {
    if (autoFiredRef.current) return
    if (walletParam) return
    if (input.trim()) return
    autoFiredRef.current = true
    let cancelled = false
    const seedFromKey = getOwnerKey()
    if (seedFromKey && seedFromKey.startsWith("0x")) {
      setInput(seedFromKey)
      setActiveWallet(seedFromKey)
      return
    }
    fetchSavedWalletForCollection("disney-pinnacle").then((addr) => {
      if (cancelled || !addr) return
      setInput(addr)
      setActiveWallet(addr)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!activeWallet) return
    let cancelled = false
    setLoading(true)
    setError(null)

    async function load() {
      try {
        const res = await fetch(`/api/pinnacle-wallet?wallet=${encodeURIComponent(activeWallet)}`)
        const json = await res.json()
        if (cancelled) return
        // `message` is the collector-facing copy (e.g. an unresolved username);
        // `error` is the machine code. Never show the code when copy exists.
        if (!res.ok) throw new Error(json?.message ?? json?.error ?? `HTTP ${res.status}`)
        setRows(Array.isArray(json.moments) ? json.moments : [])
        setTotalFmv(json.totalFmv ?? null)
        setMomentCount(json.momentCount ?? (json.moments?.length ?? 0))
        setUnlockedFmv(json.unlockedFmv ?? null)
        setUnlockedCount(json.unlockedCount ?? null)
        setBestOfferTotal(json.bestOfferTotal ?? null)
        setSpreadGap(json.spreadGap ?? null)
        setVariants(Array.isArray(json.variants) ? json.variants : [])
        setFranchises(Array.isArray(json.franchises) ? json.franchises : [])
        setHasSearched(true)
      } catch (e: any) {
        if (cancelled) return
        setError(e?.message ?? "Failed to load")
        // ⚠ momentCount goes to NULL, not 0. Every sibling here was already nulled on
        // failure; this one alone was zeroed, and it is the one rendered as a hard
        // figure — "Total Pins: 0" is a claim about the collector's OWN holdings,
        // manufactured out of our outage, sitting under the error banner that says the
        // read failed. One withheld figure beside two zeroed ones is the tell that the
        // zero was an oversight rather than a decision.
        setRows([]); setTotalFmv(null); setMomentCount(null); setVariants([]); setFranchises([])
        setUnlockedFmv(null); setUnlockedCount(null); setBestOfferTotal(null); setSpreadGap(null)
        setHasSearched(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [activeWallet])

  const sortedVariants = useMemo(() => {
    return [...variants].sort((a, b) =>
      (PINNACLE_VARIANT_RANK[b.variant_type] ?? 0) - (PINNACLE_VARIANT_RANK[a.variant_type] ?? 0))
  }, [variants])

  const sortedFranchises = useMemo(() => {
    return [...franchises].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
  }, [franchises])

  // ⚠ 2026-09-27 — THE SAME SHELL AS EVERY OTHER COLLECTION'S TAB. This page was
  // styled on its own: hardcoded white text and `rgba(255,255,255,…)` surfaces
  // (a white-on-white page in light mode), a purple "Analyze" button where every
  // other collection has the red `rpc-btn-primary` "Search", and a bare table
  // where the rest use `.rpc-table`. Layout, search bar, stat tiles and table
  // now use the tokens and classes `[collection]/collection/CollectionTabClient`
  // and `CollectionMomentTable` use, so Pinnacle reads as part of the same site.
  return (
    <div className="min-h-screen bg-[var(--rpc-black)] text-[color:var(--rpc-text-primary)] overflow-x-hidden">
      <div className="mx-auto max-w-[1600px] px-3 py-4 md:px-6">
        {/* Search bar — same markup as the shared Collection tab. */}
        <div className="mb-5 flex flex-col gap-2 sm:flex-row">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !loading && input.trim()) onSearch() }}
            placeholder="Enter Disney Pinnacle username or Flow wallet (0x…)"
            aria-label="Disney Pinnacle username or wallet address"
            className="w-full sm:max-w-lg"
            style={{
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              borderRadius: "var(--radius-md)",
              padding: "8px 12px",
              color: "var(--rpc-text-primary)",
              outline: "none",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--rpc-red)" }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--rpc-border)" }}
          />
          <div className="flex gap-2">
            <button
              onClick={onSearch}
              disabled={loading || !input.trim()}
              className="rpc-btn-primary"
              style={{
                opacity: loading || !input.trim() ? 0.5 : 1,
                cursor: loading || !input.trim() ? "not-allowed" : "pointer",
              }}
            >
              {loading ? pickLoading() : "Search"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950 p-3 text-red-300 text-sm">
            {error}
          </div>
        )}

        {(activeWallet || hasSearched) && (
          <>
            {/* Standard four-tile WalletStatRow — same component every collection
                renders. Pinnacle returns null for lockedFmv/lockedCount/bestOfferTotal
                because those concepts don't apply here. */}
            <div style={{ marginBottom: 12 }}>
              <WalletStatRow
                walletFmv={totalFmv}
                unlockedFmv={unlockedFmv}
                lockedFmv={null}
                bestOfferTotal={bestOfferTotal}
                momentCount={momentCount || null}
                unlockedCount={unlockedCount}
                lockedCount={null}
                spreadGap={spreadGap}
                collectionSlug="disney-pinnacle"
                loading={loading}
              />
            </div>

            {/* Pinnacle-specific secondary row — additive context that doesn't
                fit the universal four-tile layout. */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
              <HeaderCard label="Wallet" value={activeWallet.length > 12 ? `${activeWallet.slice(0, 6)}…${activeWallet.slice(-4)}` : activeWallet} />
              <HeaderCard label="Total Pins" value={momentCount == null ? "—" : String(momentCount)} />
              <HeaderCard label="Franchises" value={error ? "—" : String(sortedFranchises.length)} />
            </div>

            {(sortedVariants.length > 0 || sortedFranchises.length > 0) && (
              <div
                className="mb-5 grid gap-4 md:grid-cols-2"
                style={{
                  padding: 16,
                  border: "1px solid var(--rpc-border)",
                  background: "var(--rpc-surface)",
                  borderRadius: "var(--radius-lg)",
                }}
              >
                {sortedVariants.length > 0 && (
                  <div>
                    <SectionEyebrow>Variant Breakdown</SectionEyebrow>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {sortedVariants.map((v) => (
                        <div key={v.variant_type} style={chipStyle}>
                          {variantBadge(v.variant_type)}
                          <span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{v.count}</span>
                          {v.total_fmv != null && (
                            <span style={{ color: "var(--rpc-text-muted)" }}>{usd(v.total_fmv)}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {sortedFranchises.length > 0 && (
                  <div>
                    <SectionEyebrow>Franchise Breakdown</SectionEyebrow>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {sortedFranchises.slice(0, 12).map((f) => (
                        <div key={f.franchise} style={chipStyle}>
                          <span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{f.franchise}</span>
                          <span style={{ color: ACCENT, fontWeight: 600 }}>{f.count}</span>
                          {f.total_fmv != null && (
                            <span style={{ color: "var(--rpc-text-muted)" }}>{usd(f.total_fmv)}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Pins table */}
            <div className="rpc-mono" style={{ padding: "0 2px 8px", fontSize: 11, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>
              FMV is what a typical serial of that render trades at. <span style={{ color: "var(--rpc-text-secondary)" }}>Serial est.</span> applies the fitted
              serial-premium model for low serials, and is left blank on editions minted under {PINNACLE_SERIAL_MIN_MINT}, where the whole edition is
              scarce and serial position is not the price driver. Totals above use FMV, not the estimate. Rows marked{" "}
              <span style={{ color: "var(--rpc-text-secondary)", fontStyle: "italic" }}>not serialised</span> are Open, Open Event or Starter editions, which
              carry no serial numbers at all — that is the edition type, not missing data.
            </div>
            <div className="rpc-table-wrapper">
              <table className="rpc-table" style={{ minWidth: 0 }}>
                <thead>
                  <tr>
                    <th>Pin</th>
                    <th className="hidden sm:table-cell">Set</th>
                    <th className="hidden md:table-cell">Variant</th>
                    <th className="hidden sm:table-cell">Serial / Mint</th>
                    <th className="whitespace-nowrap">FMV</th>
                    <th className="hidden lg:table-cell">Serial est.</th>
                    <th className="hidden lg:table-cell">Low Ask</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => {
                    const href = pinHref(m)
                    const { studio, set } = splitPinnacleSetName(m.set_name)
                    const studioLabel = m.studio ?? studio
                    const thumb = proxyIpfsUrl(m.thumbnail_url)
                    const name = m.player_name ?? "—"
                    return (
                      <tr key={m.moment_id} style={{ cursor: "default" }}>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div style={{
                              width: 40, height: 40, flexShrink: 0, borderRadius: 6, overflow: "hidden",
                              background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border-subtle)",
                            }}>
                              {thumb ? (
                                <IpfsImg src={thumb} alt={m.player_name ?? ""} width={40} height={40} style={{ objectFit: "contain", display: "block", width: 40, height: 40 }} />
                              ) : null}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div className="rpc-table-cell--player" style={{ lineHeight: 1.25 }}>
                                {href ? (
                                  <Link href={href} prefetch={false} style={{ color: "inherit", textDecoration: "none" }}>{name}</Link>
                                ) : name}
                              </div>
                              {/* On narrow screens the Set / Variant / Serial columns are hidden,
                                  so their essentials ride under the name. */}
                              <div className="sm:hidden rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 2 }}>
                                {[studioLabel ? pinnacleStudioShort(studioLabel) : null, m.variant_type ?? m.tier].filter(Boolean).join(" · ")}
                                {m.serial_number != null ? ` · #${m.serial_number}` : ""}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="hidden sm:table-cell rpc-table-cell--muted">
                          <div style={{ lineHeight: 1.3 }}>{set ?? m.set_name ?? "—"}</div>
                          {(studioLabel || m.franchise) && (
                            <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 2 }}>
                              {[studioLabel ? pinnacleStudioShort(studioLabel) : null, m.franchise].filter(Boolean).join(" · ")}
                            </div>
                          )}
                        </td>
                        <td className="hidden md:table-cell">{variantBadge(m.variant_type ?? m.tier)}</td>
                        <td className="hidden sm:table-cell rpc-table-cell--mono">{m.serial_number != null
                          ? `#${m.serial_number}${m.mint_count ? `/${m.mint_count}` : ""}`
                          : m.is_serialised === false ? notSerialisedCell() : "—"}</td>
                        <td className="rpc-table-cell--mono" style={{ fontWeight: 600 }}>{usd(m.fmv_usd)}</td>
                        <td className="hidden lg:table-cell rpc-table-cell--mono">{serialEstCell(m)}</td>
                        <td className="hidden lg:table-cell rpc-table-cell--mono rpc-table-cell--muted">{usd(m.low_ask)}</td>
                      </tr>
                    )
                  })}
                  {/* ⚠ SECOND CLAIM SITE ON THIS PAGE, found by the test written for the
                      first. The catch sets `rows` to [], so without the `!error` guard this
                      told a collector "No Pinnacle pins found for this wallet" — a statement
                      about their OWN holdings — whenever the read failed. Sweep every site
                      that consumes the failed read, not the one you noticed. */}
                  {rows.length === 0 && !loading && !error && (
                    <tr style={{ cursor: "default" }}><td colSpan={7} className="rpc-table-empty">
                      No Pinnacle pins found for this wallet.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {loading && (
              <div className="rpc-mono" style={{ padding: 16, textAlign: "center", color: "var(--rpc-text-muted)" }}>
                Loading wallet…
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

const chipStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 8,
  padding: "4px 8px", background: "var(--rpc-surface-raised)",
  border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-md)",
  fontSize: 12, fontFamily: "var(--font-mono)",
}

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  return <div className="rpc-stat-eyebrow" style={{ marginBottom: 10 }}>{children}</div>
}

function HeaderCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rpc-stat-tile">
      <div className="rpc-stat-eyebrow">{label}</div>
      <div className="rpc-stat-value">{value}</div>
    </div>
  )
}
