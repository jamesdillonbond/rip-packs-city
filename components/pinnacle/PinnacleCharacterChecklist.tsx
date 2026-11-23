"use client"

// components/pinnacle/PinnacleCharacterChecklist.tsx
//
// Disney Pinnacle character checklist (2026-11-23, Pinnacle roadmap pass — the parity matrix's
// "Player checklists: Pinnacle —" cell). Every pin of one character, owned vs missing for a tracked
// Dapper wallet, and the cost to complete, from /api/entity/pinnacle-character-checklist
// (get_pinnacle_character_checklist — render grain, characters trait).
//
// Wallet: a pasted 0x address (the same localStorage slot the team / player checklists use), else
// the signed-in profile's wallet — never a "yours" claim while the identity read is degraded.
//
// Honesty:
//  - a failed read says so (status-checked fetch; a 404 = no pins hides the panel), never "0 owned";
//  - a wallet RPC has not indexed reads "not indexed yet", never "owns none";
//  - the cost is split by SOURCE: live asks (within 3x FMV) + FMV where nothing is listed sum into the
//    headline; an ask on a never-sold pin is shown separately; unpriced pins are counted, never $0.
// No FMV confidence anywhere (internal only, 10-18). Brand tokens only.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { useSessionOwner } from "@/lib/hooks/useSessionOwner"
import { checklistWalletStorageKey, parseChecklistWallet } from "@/lib/entity/checklist-wallet"
import { EM_DASH, fmtCount, fmtUsd } from "@/components/entity/_shared"
import { proxyIpfsImageUrl } from "@/lib/ipfs-media"

export type PinnacleCostSource = "ask" | "fmv" | "ask_no_fmv" | null

export interface PinnacleChecklistPin {
  render_id: string
  name: string | null
  set_name: string | null
  series_name: string | null
  edition_type: string | null
  variant: string | null
  parallel_type: string | null
  printing: number | null
  total_minted: number | null
  is_chaser: boolean | null
  thumbnail_url: string | null
  fmv_usd: number | null
  floor_ask_usd: number | null
  cost_usd: number | null
  cost_source: PinnacleCostSource
  owned_count: number | null
}

export interface PinnacleChecklistData {
  character: string
  wallet: string | null
  wallet_cached: boolean | null
  total: number
  owned: number | null
  missing: number | null
  cost_at_ask_usd: number
  priced_at_ask: number
  cost_at_fmv_usd: number
  priced_at_fmv: number
  cost_ask_no_fmv_usd: number
  priced_ask_no_fmv: number
  unpriced: number
  pins: PinnacleChecklistPin[]
}

const FLOW_LS_KEY = checklistWalletStorageKey("flow")
const WALLET_EVENT = "rpc-checklist-wallet"

// The pasted wallet lives in localStorage (shared with the team / player checklists). Read through
// useSyncExternalStore: the server snapshot is null, so SSR and first client render agree (no #418),
// and no setState runs inside an effect.
function subscribeWallet(cb: () => void): () => void {
  window.addEventListener("storage", cb)
  window.addEventListener(WALLET_EVENT, cb)
  return () => {
    window.removeEventListener("storage", cb)
    window.removeEventListener(WALLET_EVENT, cb)
  }
}
function readSavedWallet(): string | null {
  try {
    const p = parseChecklistWallet(window.localStorage.getItem(FLOW_LS_KEY), "flow")
    return p.ok ? p.wallet : null
  } catch {
    return null
  }
}
function writeSavedWallet(v: string | null): void {
  try {
    if (v) window.localStorage.setItem(FLOW_LS_KEY, v)
    else window.localStorage.removeItem(FLOW_LS_KEY)
  } catch { /* localStorage unavailable */ }
  window.dispatchEvent(new Event(WALLET_EVENT))
}

export type ChecklistKind = "character" | "franchise"
/** Tiles rendered before "Show all" — Star Wars has ~740 pins (11-23). */
export const CHECKLIST_PAGE = 120

type LoadResult = { kind: "error" } | { kind: "none" } | { kind: "ok"; data: PinnacleChecklistData }

/** One read of the checklist. A 404 ("no pins") is told apart from a failure; never throws. */
export async function fetchChecklist(character: string, wallet: string | null, kind: ChecklistKind = "character"): Promise<LoadResult> {
  const qs = new URLSearchParams({ character })
  if (kind !== "character") qs.set("kind", kind)
  if (wallet) qs.set("wallet", wallet)
  try {
    const res = await fetch(`/api/entity/pinnacle-character-checklist?${qs}`)
    if (res.status === 404) return { kind: "none" }
    if (!res.ok) return { kind: "error" }
    const json = (await res.json()) as PinnacleChecklistData
    if (!json || !Array.isArray(json.pins)) return { kind: "error" }
    return { kind: "ok", data: json }
  } catch {
    return { kind: "error" }
  }
}

/** The label for one pin's price — what the figure IS, never a bare number. */
export function pinPriceLabel(p: Pick<PinnacleChecklistPin, "cost_usd" | "cost_source">): string {
  if (p.cost_usd == null || p.cost_source == null) return "Unpriced"
  if (p.cost_source === "ask") return `Ask ${fmtUsd(p.cost_usd)}`
  if (p.cost_source === "fmv") return `FMV ${fmtUsd(p.cost_usd)}`
  return `Ask ${fmtUsd(p.cost_usd)} · never sold`
}

/** The cost-to-complete sentence. `null` headline when nothing is left to buy. */
export function costSummary(d: Pick<PinnacleChecklistData,
  "cost_at_ask_usd" | "priced_at_ask" | "cost_at_fmv_usd" | "priced_at_fmv" | "cost_ask_no_fmv_usd" | "priced_ask_no_fmv" | "unpriced">): {
  headline: number | null
  parts: string[]
} {
  const n = d.priced_at_ask + d.priced_at_fmv
  const headline = n > 0 ? Math.round((d.cost_at_ask_usd + d.cost_at_fmv_usd) * 100) / 100 : null
  const parts: string[] = []
  if (d.priced_at_ask > 0) parts.push(`${fmtCount(d.priced_at_ask)} at live asks`)
  if (d.priced_at_fmv > 0) parts.push(`${fmtCount(d.priced_at_fmv)} at FMV (no listing near FMV)`)
  if (d.priced_ask_no_fmv > 0) {
    parts.push(`+ ${fmtCount(d.priced_ask_no_fmv)} never-sold ${d.priced_ask_no_fmv === 1 ? "pin" : "pins"} listed at ${fmtUsd(d.cost_ask_no_fmv_usd)}, not included`)
  }
  if (d.unpriced > 0) parts.push(`${fmtCount(d.unpriced)} unpriced, not included`)
  return { headline, parts }
}

/** `kind="franchise"` (2026-11-23, pass 2) lists a franchise's pins — the team checklist's job. */
export default function PinnacleCharacterChecklist({ character, kind = "character" }: { character: string; kind?: ChecklistKind }) {
  const session = useSessionOwner()
  const pasted = useSyncExternalStore(subscribeWallet, readSavedWallet, () => null)
  const [draft, setDraft] = useState("")
  const [inputError, setInputError] = useState<string | null>(null)
  const [missingOnly, setMissingOnly] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [showAll, setShowAll] = useState(false)
  // Keyed by the request it answers: a result for another wallet/character/retry is "loading".
  const [result, setResult] = useState<{ key: string; r: LoadResult } | null>(null)

  // The profile wallet applies only when the identity read is NOT degraded (else it is unknown).
  const profileWallet = !session.loading && !session.degraded ? parseChecklistWallet(session.walletAddr, "flow") : null
  const wallet = pasted ?? (profileWallet && profileWallet.ok ? profileWallet.wallet : null)
  const isProfileWallet = !pasted && wallet !== null

  const reqKey = `${kind}|${character}|${wallet ?? ""}|${nonce}`
  useEffect(() => {
    if (session.loading) return
    let live = true
    void fetchChecklist(character, wallet, kind).then((r) => { if (live) setResult({ key: reqKey, r }) })
    return () => { live = false }
  }, [character, wallet, kind, reqKey, session.loading])
  const state: { kind: "loading" } | LoadResult = result && result.key === reqKey ? result.r : { kind: "loading" }

  const onTrack = () => {
    const p = parseChecklistWallet(draft, "flow")
    if (!p.ok || !p.wallet) {
      setInputError("Enter a Dapper wallet address (0x followed by 16 characters).")
      return
    }
    setInputError(null)
    writeSavedWallet(p.wallet)
  }
  const onClear = () => {
    setDraft("")
    setMissingOnly(false)
    writeSavedWallet(null)
  }

  const data = state.kind === "ok" ? state.data : null
  const tracking = !!(data && data.wallet && data.wallet_cached)
  const pins = useMemo(() => {
    if (!data) return []
    return missingOnly && tracking ? data.pins.filter((p) => (p.owned_count ?? 0) === 0) : data.pins
  }, [data, missingOnly, tracking])

  if (state.kind === "none") return null

  const muted = { color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 } as const

  return (
    <div data-testid="pinnacle-character-checklist">
      {/* Wallet row */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
        {wallet ? (
          <>
            <span style={muted}>
              {isProfileWallet ? "Your wallet" : <>Tracking <code>{wallet.slice(0, 6)}…{wallet.slice(-4)}</code></>}
            </span>
            {!isProfileWallet ? (
              <button type="button" className="rpc-btn-ghost" onClick={onClear} style={{ fontSize: 12 }}>Clear</button>
            ) : null}
          </>
        ) : (
          <>
            <label htmlFor="pcc-wallet" style={muted}>See which you own:</label>
            <input
              id="pcc-wallet"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onTrack() }}
              placeholder="0x… Dapper wallet"
              autoComplete="off"
              spellCheck={false}
              style={{
                flex: "1 1 180px", minWidth: 0, maxWidth: 260, padding: "6px 8px",
                background: "var(--rpc-surface)", color: "var(--rpc-text-primary)",
                border: "1px solid var(--rpc-border)", borderRadius: 6, fontFamily: "var(--font-mono)", fontSize: 12,
              }}
            />
            <button type="button" className="rpc-btn-primary" onClick={onTrack} style={{ fontSize: 12 }}>Track</button>
          </>
        )}
        {tracking ? (
          <label style={{ ...muted, display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
            Missing only
          </label>
        ) : null}
      </div>
      {inputError ? <div role="alert" style={{ ...muted, color: "var(--rpc-red-text)", marginBottom: 8 }}>{inputError}</div> : null}

      {state.kind === "loading" ? <div style={muted}>Loading {character}&apos;s pins…</div> : null}
      {state.kind === "error" ? (
        <div style={muted}>
          The checklist couldn&apos;t load right now.{" "}
          <button type="button" className="rpc-btn-ghost" onClick={() => setNonce((n) => n + 1)} style={{ fontSize: 12 }}>Retry</button>
        </div>
      ) : null}

      {data ? <ChecklistHeader data={data} /> : null}

      {data ? (
        <div
          style={{
            display: "grid", gap: 8, marginTop: 10,
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          }}
        >
          {(showAll ? pins : pins.slice(0, CHECKLIST_PAGE)).map((p) => {
            const owned = (p.owned_count ?? 0) > 0
            const dim = tracking && !owned
            return (
              <Link
                key={p.render_id}
                href={`/pinnacle/moment/${encodeURIComponent(p.render_id)}`}
                prefetch={false}
                className="rpc-card"
                style={{
                  display: "flex", flexDirection: "column", gap: 4, padding: 8, textDecoration: "none", color: "inherit",
                  border: owned && tracking ? "1px solid var(--rpc-success, var(--rpc-border))" : "1px solid var(--rpc-border)",
                  opacity: dim ? 0.72 : 1,
                }}
              >
                {p.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={proxyIpfsImageUrl(p.thumbnail_url) ?? undefined} alt={`${p.name ?? character} — ${p.variant ?? ""}`} loading="lazy" width={120} height={120}
                    style={{ width: "100%", height: "auto", aspectRatio: "1 / 1", objectFit: "contain" }} />
                ) : null}
                <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.25 }}>{p.name ?? character}</div>
                <div style={{ ...muted, fontSize: 11, lineHeight: 1.3 }}>
                  {[p.variant, p.edition_type].filter(Boolean).join(" · ") || EM_DASH}
                  {p.is_chaser ? " · Chaser" : ""}
                </div>
                <div style={{ ...muted, fontSize: 10, lineHeight: 1.3 }}>{p.set_name ?? EM_DASH}</div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 4, marginTop: "auto", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  <span>{pinPriceLabel(p)}</span>
                  {tracking ? (
                    <span style={{ color: owned ? "var(--rpc-success, var(--rpc-text-primary))" : "var(--rpc-text-muted)" }}>
                      {owned ? `✓${(p.owned_count ?? 0) > 1 ? ` ×${p.owned_count}` : ""}` : "Missing"}
                    </span>
                  ) : null}
                </div>
              </Link>
            )
          })}
        </div>
      ) : null}
      {data && !showAll && pins.length > CHECKLIST_PAGE ? (
        <button type="button" className="rpc-btn-ghost" onClick={() => setShowAll(true)} style={{ marginTop: 10, fontSize: 12 }}>
          Show all {fmtCount(pins.length)} pins
        </button>
      ) : null}
    </div>
  )
}

function ChecklistHeader({ data }: { data: PinnacleChecklistData }) {
  const muted = { color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 } as const
  const { headline, parts } = costSummary(data)
  const tracking = !!(data.wallet && data.wallet_cached)

  if (data.wallet && data.wallet_cached === false) {
    return (
      <div style={muted}>
        {fmtCount(data.total)} pins. RPC hasn&apos;t indexed this wallet&apos;s Disney Pinnacle pins yet —{" "}
        <Link href={`/disney-pinnacle/collection?wallet=${encodeURIComponent(data.wallet)}`} rel="nofollow">open it in the Collection tab</Link>{" "}
        to load it, then come back.
      </div>
    )
  }

  const complete = tracking && data.missing === 0
  const pct = tracking && data.total > 0 && data.owned != null ? Math.round((data.owned / data.total) * 1000) / 10 : null
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 18, letterSpacing: 0.5 }}>
        {tracking
          ? <>{fmtCount(data.owned)} of {fmtCount(data.total)} pins owned{pct != null ? ` · ${pct}%` : ""}</>
          : <>{fmtCount(data.total)} pins</>}
      </div>
      {complete ? (
        <div style={muted}>Complete — this wallet holds every {data.character} pin RPC knows of.</div>
      ) : (
        <div style={muted}>
          {tracking ? "Cost to complete" : "Cost of the full set"}:{" "}
          <strong style={{ color: "var(--rpc-text-primary)" }}>{headline != null ? `≈ ${fmtUsd(headline)}` : EM_DASH}</strong>
          {parts.length ? <> ({parts.join("; ")})</> : null}
        </div>
      )}
    </div>
  )
}
