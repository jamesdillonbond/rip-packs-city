"use client"

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

const ACCENT = "#A855F7"
const PAGE_SIZE = 100

function usd(n: number | null | undefined) {
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
      style={{ color: "rgba(255,255,255,0.32)", fontStyle: "italic", fontSize: 11 }}
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
    return <span style={{ color: "rgba(255,255,255,0.55)" }}>{usd(m.serial_fmv)}</span>
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ color: ACCENT, fontWeight: 600 }}>{usd(m.serial_fmv)}</span>
      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.45)" }}>×{mult.toFixed(2)}</span>
    </span>
  )
}

function variantBadge(variant: string | null | undefined) {
  const v = variant ?? "Standard"
  const color = PINNACLE_VARIANT_COLORS[v] ?? "#6B7280"
  return (
    <span style={{
      display: "inline-block", padding: "1px 6px", borderRadius: 3,
      fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700,
      color, background: `${color}22`, border: `1px solid ${color}55`, letterSpacing: "0.05em",
    }}>{v}</span>
  )
}

export default function PinnacleCollectionClient() {
  return (
    <Suspense fallback={<div style={{ color: "rgba(255,255,255,0.5)", padding: 20 }}>Loading…</div>}>
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
    router.replace(`/disney-pinnacle/collection?wallet=${encodeURIComponent(w)}`)
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

  return (
    <div style={{ color: "#fff", paddingTop: 20 }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSearch()}
          placeholder="Enter Flow wallet (0x...)"
          style={{
            flex: 1, padding: "10px 12px", borderRadius: 4,
            background: "rgba(255,255,255,0.04)", border: `1px solid ${ACCENT}44`,
            color: "#fff", fontFamily: "var(--font-mono)", fontSize: 13,
          }}
        />
        <button
          onClick={onSearch}
          style={{
            padding: "10px 20px", background: ACCENT, color: "#fff",
            border: "none", borderRadius: 4, fontFamily: "var(--font-display)",
            fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer",
          }}>Analyze</button>
      </div>

      {error && (
        <div style={{ padding: 12, marginBottom: 16, border: "1px solid #EF444466", color: "#FCA5A5", borderRadius: 4 }}>
          {error}
        </div>
      )}

      {(activeWallet || hasSearched) && (
        <>
          {/* Standard four-tile WalletStatRow — same component every collection
              renders. Pinnacle returns null for lockedFmv/lockedCount/bestOfferTotal
              because those concepts don't apply here. */}
          <div style={{ marginBottom: 16 }}>
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 24 }}>
            <HeaderCard label="Wallet" value={`${activeWallet.slice(0, 6)}…${activeWallet.slice(-4)}`} />
            <HeaderCard label="Total Pins" value={momentCount == null ? "—" : String(momentCount)} />
            <HeaderCard label="Franchises" value={String(sortedFranchises.length)} />
          </div>

          {/* Variant breakdown */}
          {sortedVariants.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.6)", marginBottom: 8 }}>
                Variant Breakdown
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {sortedVariants.map((v) => (
                  <div key={v.variant_type} style={{
                    padding: "6px 10px", background: "rgba(255,255,255,0.03)",
                    border: `1px solid ${PINNACLE_VARIANT_COLORS[v.variant_type] ?? "#6B7280"}66`,
                    borderRadius: 4, fontSize: 12, fontFamily: "var(--font-mono)",
                  }}>
                    {variantBadge(v.variant_type)}
                    <span style={{ marginLeft: 8, color: "#fff" }}>{v.count}</span>
                    {v.total_fmv != null && (
                      <span style={{ marginLeft: 6, color: "rgba(255,255,255,0.5)" }}>{usd(v.total_fmv)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Franchise breakdown */}
          {sortedFranchises.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.6)", marginBottom: 8 }}>
                Franchise Breakdown
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {sortedFranchises.slice(0, 12).map((f) => (
                  <div key={f.franchise} style={{
                    padding: "6px 10px", background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4,
                    fontSize: 12, fontFamily: "var(--font-mono)",
                  }}>
                    <span style={{ color: "#fff", fontWeight: 600 }}>{f.franchise}</span>
                    <span style={{ marginLeft: 8, color: ACCENT }}>{f.count}</span>
                    {f.total_fmv != null && (
                      <span style={{ marginLeft: 6, color: "rgba(255,255,255,0.5)" }}>{usd(f.total_fmv)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pins table */}
          <div className="rpc-mono" style={{ padding: "0 2px 6px", fontSize: 10, color: "rgba(255,255,255,0.45)", letterSpacing: "0.05em" }}>
            FMV is what a typical serial of that render trades at. <span style={{ color: "rgba(255,255,255,0.7)" }}>Serial est.</span> applies the fitted
            serial-premium model for low serials, and is left blank on editions minted under {PINNACLE_SERIAL_MIN_MINT}, where the whole edition is
            scarce and serial position is not the price driver. Totals above use FMV, not the estimate. Rows marked{" "}
            <span style={{ color: "rgba(255,255,255,0.55)", fontStyle: "italic" }}>not serialised</span> are Open, Open Event or Starter editions, which
            carry no serial numbers at all — that is the edition type, not missing data.
          </div>
          <div style={{ overflow: "auto", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "var(--font-mono)" }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.6)", textAlign: "left" }}>
                  <Th>Character</Th>
                  <Th>Franchise</Th>
                  <Th>Set</Th>
                  <Th>Variant</Th>
                  <Th>Serial</Th>
                  <Th>FMV</Th>
                  <Th>Serial est.</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.moment_id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                    <Td>{m.player_name ?? "—"}</Td>
                    <Td>{m.franchise ?? "—"}</Td>
                    <Td style={{ color: "rgba(255,255,255,0.7)" }}>{m.set_name ?? "—"}{m.studio ? ` · ${pinnacleStudioShort(m.studio)}` : ""}</Td>
                    <Td>{variantBadge(m.variant_type ?? m.tier)}</Td>
                    <Td>{m.serial_number != null
                      ? `#${m.serial_number}${m.mint_count ? `/${m.mint_count}` : ""}`
                      : m.is_serialised === false ? notSerialisedCell() : "—"}</Td>
                    <Td>{usd(m.fmv_usd)}</Td>
                    <Td>{serialEstCell(m)}</Td>
                  </tr>
                ))}
                {/* ⚠ SECOND CLAIM SITE ON THIS PAGE, found by the test written for the
                    first. The catch sets `rows` to [], so without the `!error` guard this
                    told a collector "No Pinnacle pins found for this wallet" — a statement
                    about their OWN holdings — whenever the read failed. Sweep every site
                    that consumes the failed read, not the one you noticed. */}
                {rows.length === 0 && !loading && !error && (
                  <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: "rgba(255,255,255,0.4)" }}>
                    No Pinnacle pins found for this wallet.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {loading && (
            <div style={{ padding: 16, textAlign: "center", color: "rgba(255,255,255,0.5)" }}>
              Loading wallet…
            </div>
          )}
        </>
      )}
    </div>
  )
}

function HeaderCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      padding: 14, background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4,
    }}>
      <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", letterSpacing: "0.1em", color: "rgba(255,255,255,0.4)", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontFamily: "var(--font-display)", fontWeight: 900, color: "#fff", marginTop: 4 }}>
        {value}
      </div>
    </div>
  )
}

const thTdStyle = { padding: "8px 12px", whiteSpace: "nowrap" as const }
function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ ...thTdStyle, fontWeight: 700, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase" }}>{children}</th>
}
function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ ...thTdStyle, ...style }}>{children}</td>
}
