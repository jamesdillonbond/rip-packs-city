"use client"

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import {
  PINNACLE_COLLECTION_ID,
  PINNACLE_VARIANT_COLORS,
  PINNACLE_VARIANT_RANK,
  pinnacleStudioShort,
} from "@/lib/pinnacle/pinnacleTypes"

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
  mint_count?: number | null
  thumbnail_url?: string | null
}

type VariantBucket = { variant_type: string; count: number; total_fmv: number | null }
type FranchiseBucket = { franchise: string; count: number; total_fmv: number | null }

const ACCENT = "#A855F7"
const PAGE_SIZE = 100

function usd(n: number | null | undefined) {
  if (n == null || !isFinite(Number(n))) return "—"
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function variantBadge(variant: string | null | undefined) {
  const v = variant ?? "Standard"
  const color = PINNACLE_VARIANT_COLORS[v] ?? "#6B7280"
  return (
    <span style={{
      display: "inline-block", padding: "1px 6px", borderRadius: 3,
      fontSize: 10, fontFamily: "'Share Tech Mono', monospace", fontWeight: 700,
      color, background: `${color}22`, border: `1px solid ${color}55`, letterSpacing: "0.05em",
    }}>{v}</span>
  )
}

export default function PinnacleCollectionPage() {
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
  const [momentCount, setMomentCount] = useState<number>(0)
  const [variants, setVariants] = useState<VariantBucket[]>([])
  const [franchises, setFranchises] = useState<FranchiseBucket[]>([])
  const [error, setError] = useState<string | null>(null)

  const onSearch = useCallback(() => {
    const w = input.trim()
    if (!w) return
    setActiveWallet(w)
    router.replace(`/disney-pinnacle/collection?wallet=${encodeURIComponent(w)}`)
  }, [input, router])

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
        if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
        setRows(Array.isArray(json.moments) ? json.moments : [])
        setTotalFmv(json.totalFmv ?? null)
        setMomentCount(json.momentCount ?? (json.moments?.length ?? 0))
        setVariants(Array.isArray(json.variants) ? json.variants : [])
        setFranchises(Array.isArray(json.franchises) ? json.franchises : [])
      } catch (e: any) {
        if (cancelled) return
        setError(e?.message ?? "Failed to load")
        setRows([]); setTotalFmv(null); setMomentCount(0); setVariants([]); setFranchises([])
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
            color: "#fff", fontFamily: "'Share Tech Mono', monospace", fontSize: 13,
          }}
        />
        <button
          onClick={onSearch}
          style={{
            padding: "10px 20px", background: ACCENT, color: "#fff",
            border: "none", borderRadius: 4, fontFamily: "'Barlow Condensed', sans-serif",
            fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer",
          }}>Analyze</button>
      </div>

      {error && (
        <div style={{ padding: 12, marginBottom: 16, border: "1px solid #EF444466", color: "#FCA5A5", borderRadius: 4 }}>
          {error}
        </div>
      )}

      {activeWallet && (
        <>
          {/* Header cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 24 }}>
            <HeaderCard label="Wallet" value={`${activeWallet.slice(0, 6)}…${activeWallet.slice(-4)}`} />
            <HeaderCard label="Total Pins" value={String(momentCount)} />
            <HeaderCard label="Total FMV" value={usd(totalFmv)} />
            <HeaderCard label="Franchises" value={String(sortedFranchises.length)} />
          </div>

          {/* Variant breakdown */}
          {sortedVariants.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 14, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.6)", marginBottom: 8 }}>
                Variant Breakdown
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {sortedVariants.map((v) => (
                  <div key={v.variant_type} style={{
                    padding: "6px 10px", background: "rgba(255,255,255,0.03)",
                    border: `1px solid ${PINNACLE_VARIANT_COLORS[v.variant_type] ?? "#6B7280"}66`,
                    borderRadius: 4, fontSize: 12, fontFamily: "'Share Tech Mono', monospace",
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
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 14, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.6)", marginBottom: 8 }}>
                Franchise Breakdown
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {sortedFranchises.slice(0, 12).map((f) => (
                  <div key={f.franchise} style={{
                    padding: "6px 10px", background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4,
                    fontSize: 12, fontFamily: "'Share Tech Mono', monospace",
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
          <div style={{ overflow: "auto", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "'Share Tech Mono', monospace" }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.6)", textAlign: "left" }}>
                  <Th>Character</Th>
                  <Th>Franchise</Th>
                  <Th>Set</Th>
                  <Th>Variant</Th>
                  <Th>Serial</Th>
                  <Th>FMV</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.moment_id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                    <Td>{m.player_name ?? "—"}</Td>
                    <Td>{m.franchise ?? "—"}</Td>
                    <Td style={{ color: "rgba(255,255,255,0.7)" }}>{m.set_name ?? "—"}{m.studio ? ` · ${pinnacleStudioShort(m.studio)}` : ""}</Td>
                    <Td>{variantBadge(m.variant_type ?? m.tier)}</Td>
                    <Td>{m.serial_number != null ? `#${m.serial_number}${m.mint_count ? `/${m.mint_count}` : ""}` : "—"}</Td>
                    <Td>{usd(m.fmv_usd)}</Td>
                  </tr>
                ))}
                {rows.length === 0 && !loading && (
                  <tr><td colSpan={6} style={{ padding: 24, textAlign: "center", color: "rgba(255,255,255,0.4)" }}>
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
      <div style={{ fontSize: 10, fontFamily: "'Share Tech Mono', monospace", letterSpacing: "0.1em", color: "rgba(255,255,255,0.4)", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, color: "#fff", marginTop: 4 }}>
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

// Suppress unused import warnings in case code is pruned later
void PINNACLE_COLLECTION_ID
