"use client"

// app/dashboard/trade-hub/TradeHubClient.tsx
//
// Trade Hub scaffold: wishlist + offers + matches in three sections. CRUD
// only — trade execution is intentionally not in scope yet. Forms accept
// raw edition_id / collection_id / moment_id strings until an in-context
// picker lands. Rendered only when the server gate in page.tsx allows it
// (RPC_TRADE_ESCROW_ADDRESS set); otherwise the route 404s.

import { useCallback, useEffect, useState } from "react"

type Tab = "wishlist" | "offers" | "matches"

interface WishlistItem {
  id: string
  edition_id: string
  collection_id: string
  max_price_usd: number | null
  notes: string | null
  created_at: string
}

interface OfferItem {
  id: string
  wallet_address: string
  moment_id: string
  edition_id: string
  collection_id: string
  ask_price_usd: number | null
  open_to_trades: boolean | null
  notes: string | null
  expires_at: string | null
  status: string | null
}

interface MatchItem {
  id: string
  wishlist_id: string | null
  offer_id: string | null
  buyer_user_id: string | null
  seller_user_id: string | null
  edition_id: string | null
  collection_id: string | null
  match_score: number | null
  reason: string | null
  surfaced_at: string | null
}

const FONT_STACK = "system-ui, -apple-system, sans-serif"
const ACCENT = "var(--rpc-red, #E03A2F)"

export default function TradeHubClient() {
  const [tab, setTab] = useState<Tab>("wishlist")
  return (
    <main style={{ padding: "2rem", color: "#fafafa", background: "#0a0a0a", minHeight: "100vh", fontFamily: FONT_STACK }}>
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <h1 style={{ fontFamily: "var(--font-display, 'Barlow Condensed')", fontSize: "2rem", letterSpacing: "0.04em", margin: "0 0 4px", color: ACCENT }}>Trade Hub</h1>
        <p style={{ color: "rgba(255,255,255,0.55)", margin: "0 0 24px", fontSize: 14 }}>
          Wishlist editions you want, mark moments you'd trade, and review pending matches. Trade execution is not yet supported.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
          <TabButton current={tab} value="wishlist" onClick={setTab} label="Wishlist" />
          <TabButton current={tab} value="offers" onClick={setTab} label="My offers" />
          <TabButton current={tab} value="matches" onClick={setTab} label="Matches" />
        </div>

        {tab === "wishlist" && <WishlistTab />}
        {tab === "offers" && <OffersTab />}
        {tab === "matches" && <MatchesTab />}
      </div>
    </main>
  )
}

function TabButton({ current, value, onClick, label }: { current: Tab; value: Tab; onClick: (t: Tab) => void; label: string }) {
  const active = current === value
  return (
    <button
      onClick={() => onClick(value)}
      style={{
        padding: "8px 18px", borderRadius: 8, border: active ? `1px solid ${ACCENT}` : "1px solid #27272a",
        background: active ? ACCENT : "transparent", color: active ? "#0a0a0a" : "#fafafa",
        fontWeight: 600, cursor: "pointer",
      }}
    >{label}</button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <h2 style={{ fontSize: "1rem", margin: "0 0 12px" }}>{title}</h2>
      {children}
    </section>
  )
}

function WishlistTab() {
  const [items, setItems] = useState<WishlistItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editionId, setEditionId] = useState("")
  const [collectionId, setCollectionId] = useState("")
  const [maxPrice, setMaxPrice] = useState("")
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/trade-hub/wishlist", { credentials: "include" })
      const j = await res.json()
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`)
      setItems(j.wishlist ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch("/api/trade-hub/wishlist", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          edition_id: editionId.trim(),
          collection_id: collectionId.trim(),
          max_price_usd: maxPrice ? Number(maxPrice) : null,
          notes: notes || null,
        }),
      })
      const j = await res.json()
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`)
      setEditionId(""); setCollectionId(""); setMaxPrice(""); setNotes("")
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setSubmitting(false) }
  }

  async function remove(id: string) {
    try {
      const res = await fetch(`/api/trade-hub/wishlist?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await reload()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <>
      <Section title="Add edition to wishlist">
        <form onSubmit={add} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input value={editionId} onChange={e => setEditionId(e.target.value)} placeholder="Edition UUID" style={inputStyle} required />
          <input value={collectionId} onChange={e => setCollectionId(e.target.value)} placeholder="Collection UUID" style={inputStyle} required />
          <input value={maxPrice} onChange={e => setMaxPrice(e.target.value)} placeholder="Max price USD (optional)" type="number" style={inputStyle} />
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" style={inputStyle} />
          <button type="submit" disabled={submitting} style={{ ...buttonStyle, gridColumn: "1 / -1" }}>{submitting ? "Adding…" : "Add to wishlist"}</button>
        </form>
      </Section>

      {error && <div style={errStyle}>{error}</div>}

      <Section title={`Your wishlist${items ? ` (${items.length})` : ""}`}>
        {items === null ? <p style={mutedStyle}>Loading…</p> : items.length === 0 ? <p style={mutedStyle}>Nothing yet.</p> : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map(i => (
              <li key={i.id} style={cardStyle}>
                <div style={{ fontSize: 13 }}><strong>Edition</strong> <code style={codeStyle}>{i.edition_id}</code></div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)" }}>
                  {i.max_price_usd != null && <>Max ${i.max_price_usd.toFixed(2)} · </>}
                  {i.notes ?? "—"}
                </div>
                <button onClick={() => remove(i.id)} style={removeBtnStyle}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

function OffersTab() {
  const [items, setItems] = useState<OfferItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [walletAddress, setWalletAddress] = useState("")
  const [momentId, setMomentId] = useState("")
  const [editionId, setEditionId] = useState("")
  const [collectionId, setCollectionId] = useState("")
  const [askPrice, setAskPrice] = useState("")
  const [openToTrades, setOpenToTrades] = useState(true)
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/trade-hub/offers", { credentials: "include" })
      const j = await res.json()
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`)
      setItems(j.offers ?? [])
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { reload() }, [reload])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch("/api/trade-hub/offers", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet_address: walletAddress.trim(),
          moment_id: momentId.trim(),
          edition_id: editionId.trim(),
          collection_id: collectionId.trim(),
          ask_price_usd: askPrice ? Number(askPrice) : null,
          open_to_trades: openToTrades,
          notes: notes || null,
        }),
      })
      const j = await res.json()
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`)
      setWalletAddress(""); setMomentId(""); setEditionId(""); setCollectionId(""); setAskPrice(""); setNotes("")
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setSubmitting(false) }
  }

  async function remove(id: string) {
    try {
      const res = await fetch(`/api/trade-hub/offers?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await reload()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <>
      <Section title="Mark a moment as open to trade">
        <form onSubmit={add} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input value={walletAddress} onChange={e => setWalletAddress(e.target.value)} placeholder="Wallet address (0x…)" style={inputStyle} required />
          <input value={momentId} onChange={e => setMomentId(e.target.value)} placeholder="Moment ID" style={inputStyle} required />
          <input value={editionId} onChange={e => setEditionId(e.target.value)} placeholder="Edition UUID" style={inputStyle} required />
          <input value={collectionId} onChange={e => setCollectionId(e.target.value)} placeholder="Collection UUID" style={inputStyle} required />
          <input value={askPrice} onChange={e => setAskPrice(e.target.value)} placeholder="Ask price USD (optional)" type="number" style={inputStyle} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.65)", fontSize: 13 }}>
            <input type="checkbox" checked={openToTrades} onChange={e => setOpenToTrades(e.target.checked)} />
            Open to trades
          </label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" style={{ ...inputStyle, gridColumn: "1 / -1" }} />
          <button type="submit" disabled={submitting} style={{ ...buttonStyle, gridColumn: "1 / -1" }}>{submitting ? "Saving…" : "Mark open to trade"}</button>
        </form>
      </Section>

      {error && <div style={errStyle}>{error}</div>}

      <Section title={`Your open offers${items ? ` (${items.length})` : ""}`}>
        {items === null ? <p style={mutedStyle}>Loading…</p> : items.length === 0 ? <p style={mutedStyle}>Nothing yet.</p> : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map(i => (
              <li key={i.id} style={cardStyle}>
                <div style={{ fontSize: 13 }}><strong>Moment</strong> <code style={codeStyle}>{i.moment_id}</code></div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)" }}>
                  {i.ask_price_usd != null && <>Ask ${i.ask_price_usd.toFixed(2)} · </>}
                  {i.open_to_trades ? "Trades OK" : "Sale only"}
                  {i.status && i.status !== "open" && <> · {i.status}</>}
                </div>
                <button onClick={() => remove(i.id)} style={removeBtnStyle}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

function MatchesTab() {
  const [items, setItems] = useState<MatchItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recomputing, setRecomputing] = useState(false)

  const reload = useCallback(async (recompute: boolean) => {
    try {
      const url = recompute ? "/api/trade-hub/matches?recompute=true" : "/api/trade-hub/matches"
      const res = await fetch(url, { credentials: "include" })
      const j = await res.json()
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`)
      setItems(j.matches ?? [])
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])

  useEffect(() => { reload(false) }, [reload])

  async function recompute() {
    setRecomputing(true)
    try { await reload(true) } finally { setRecomputing(false) }
  }

  return (
    <>
      <Section title="Pending matches">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8 }}>
          <span style={{ color: "rgba(255,255,255,0.55)", fontSize: 13 }}>{items ? `${items.length} match${items.length === 1 ? "" : "es"}` : "Loading…"}</span>
          <button onClick={recompute} disabled={recomputing} style={{ ...buttonStyle, padding: "6px 14px" }}>{recomputing ? "Recomputing…" : "Recompute"}</button>
        </div>
        {error && <div style={errStyle}>{error}</div>}
        {items && items.length === 0 ? <p style={mutedStyle}>No pending matches. Add more wishlist items or trade-open offers to surface candidates.</p> : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {(items ?? []).map(m => (
              <li key={m.id} style={cardStyle}>
                <div style={{ fontSize: 13 }}>
                  <strong>Score:</strong> {m.match_score != null ? m.match_score.toFixed(1) : "—"}
                </div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.55)" }}>{m.reason ?? "—"}</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)", marginTop: 4 }}>
                  Edition <code style={codeStyle}>{m.edition_id ?? "—"}</code>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

const inputStyle: React.CSSProperties = {
  background: "#0a0a0a", color: "#fafafa", border: "1px solid #27272a",
  borderRadius: 6, padding: "8px 10px", fontFamily: "inherit",
}
const buttonStyle: React.CSSProperties = {
  padding: "10px 18px", background: ACCENT, color: "#0a0a0a", border: 0,
  borderRadius: 8, fontWeight: 700, cursor: "pointer",
}
const removeBtnStyle: React.CSSProperties = {
  marginTop: 6, padding: "4px 10px", background: "transparent",
  color: "#fecaca", border: "1px solid #7f1d1d", borderRadius: 6, cursor: "pointer", fontSize: 12,
}
const mutedStyle: React.CSSProperties = { color: "rgba(255,255,255,0.45)", fontSize: 13, margin: 0 }
const cardStyle: React.CSSProperties = { background: "#0a0a0a", border: "1px solid #27272a", borderRadius: 8, padding: 12 }
const errStyle: React.CSSProperties = {
  background: "#7f1d1d", color: "#fecaca", padding: "10px 14px",
  borderRadius: 8, marginBottom: 12, fontSize: 13,
}
const codeStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono, 'Share Tech Mono')", fontSize: 12,
  background: "#27272a", padding: "2px 6px", borderRadius: 4, color: "rgba(255,255,255,0.65)",
}
