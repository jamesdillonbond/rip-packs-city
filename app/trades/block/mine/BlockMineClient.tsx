"use client"

// app/trades/block/mine/BlockMineClient.tsx
//
// My Trade Block (signed in): prove the accounts your assets sit in, post a listing (what
// you'd trade from those accounts, what you want back), close listings, and answer the
// proposals on them. Accepting a proposal whose every asset is NBA Top Shot opens a trade
// room for the two of you; anything else reads "agreed — signing on RPC is Top Shot only
// for now", and nothing is offered that the product cannot do.
//
// The Flow Wallet here signs an account PROOF only (a sign-in, no fee) — the Trade Block's
// one wallet use (Trevor, 2026-11-02; pinned in __tests__/no-client-wallet-connect.test.ts).
// It never signs a transaction on this page.

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { errorText } from "@/lib/giveaways/view-format"
import type { Holding } from "@/lib/trade-block/store"
import type { ListingView, ProposalView } from "@/lib/trade-block/view"
import { lineView, valueLine } from "@/lib/trade-block/view"
import { BLOCK_COLLECTIONS, MAX_LINES_PER_SIDE, NOTE_MAX } from "@/lib/trade-block/rules"
import { Line, LineList, ListingCard, ptDate } from "../block-ui"
import { btn, btnPrimary, call, card, DISPLAY, errorOf, fmtUsd, label, MONO, muted, shortAddr, type Called } from "../../trade-ui"

const loadWallet = () => import("@/lib/trade-room/trade-wallet")

type Wallet = { source: string; signer: string; proven_at: string | null }
type Mine = { wallets: Wallet[]; listings: ListingView[]; proposals: { sent: ProposalView[]; received: ProposalView[] } }
type Load = { kind: "loading" } | { kind: "error"; error: string } | { kind: "ok"; mine: Mine }
type Account = { address: string; role: string; name: string | null; dapper: boolean }
type Proof = { address: string; nonce: string; signatures: unknown[]; issuedAt: string }

function asMine(r: Called): Mine | null {
  const b = r.body as Partial<Mine> | null
  if (!r.ok || !b || !Array.isArray(b.wallets) || !Array.isArray(b.listings) || !b.proposals) return null
  return b as Mine
}

const input: React.CSSProperties = {
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--rpc-border)",
  background: "var(--rpc-bg)",
  color: "var(--rpc-text-primary)",
  fontSize: 13,
  minWidth: 0,
}

export default function BlockMineClient() {
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [msg, setMsg] = useState<string | null>(null)

  const read = useCallback(async () => {
    const r = await call("/api/trade-block")
    const mine = asMine(r)
    setLoad(mine ? { kind: "ok", mine } : { kind: "error", error: r.ok ? "The response was missing your Trade Block." : errorOf(r) })
  }, [])

  useEffect(() => {
    let live = true
    void call("/api/trade-block").then((r) => {
      if (!live) return
      const mine = asMine(r)
      setLoad(mine ? { kind: "ok", mine } : { kind: "error", error: r.ok ? "The response was missing your Trade Block." : errorOf(r) })
    })
    return () => {
      live = false
    }
  }, [])

  const update = (r: Called) => {
    const mine = asMine(r)
    if (mine) setLoad({ kind: "ok", mine })
  }

  return (
    <main id="content" style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px 80px", display: "flex", flexDirection: "column", gap: 16 }}>
      <Link href="/trades/block" style={{ ...muted, textDecoration: "none" }}>
        ← Trade Block
      </Link>
      <div>
        <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: "0 0 4px", fontSize: 28 }}>My Trade Block</h1>
        <p style={{ ...muted, margin: 0, fontSize: 14 }}>Post what you&apos;d trade and what you want back. Asset for asset — no cash. Your wallet addresses are never shown to anyone.</p>
      </div>
      {msg ? <p style={{ margin: 0, fontSize: 13, color: "var(--rpc-text-primary)" }}>{msg}</p> : null}
      {load.kind === "loading" ? (
        <p style={muted}>Loading your Trade Block…</p>
      ) : load.kind === "error" ? (
        <section style={{ ...card, borderColor: "var(--rpc-danger-text)" }}>
          <p style={{ margin: "0 0 8px", color: "var(--rpc-danger-text)", fontSize: 13 }}>Couldn&apos;t load your Trade Block: {load.error}</p>
          <button type="button" style={btn} onClick={() => void read()}>
            Retry
          </button>
        </section>
      ) : (
        <>
          <Wallets wallets={load.mine.wallets} onUpdate={update} />
          {load.mine.wallets.length > 0 ? <Composer onPosted={() => void read()} setMsg={setMsg} /> : null}
          <Proposals title="Proposals on your listings" list={load.mine.proposals.received} onUpdate={update} setMsg={setMsg} />
          <Listings listings={load.mine.listings} onUpdate={update} />
          <Proposals title="Proposals you sent" list={load.mine.proposals.sent} onUpdate={update} setMsg={setMsg} />
        </>
      )}
    </main>
  )
}

// ── 1 · proven accounts ──────────────────────────────────────────────────────

function Wallets({ wallets, onUpdate }: { wallets: Wallet[]; onUpdate: (r: Called) => void }) {
  const [connecting, setConnecting] = useState(false)
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [proof, setProof] = useState<Proof | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const save = async (signed: Proof, source: string) => {
    const r = await call("/api/trade-block", { method: "POST", body: JSON.stringify({ action: "wallet", proof: signed, source }) })
    if (!r.ok) return setErr(errorOf(r))
    setAccounts(null)
    onUpdate(r)
  }

  const connect = async () => {
    setConnecting(true)
    setErr(null)
    try {
      const n = await call("/api/trade-block?nonce=1")
      if (!n.ok || typeof n.body?.nonce !== "string" || typeof n.body?.issuedAt !== "string") throw new Error(errorOf(n))
      const w = await loadWallet()
      const connected = await w.connectTradeWalletWithProof(n.body.nonce)
      if (!connected.proof) throw new Error("Your wallet didn't send the sign-in that proves it's yours. Update Flow Wallet and try again.")
      const signed: Proof = { ...connected.proof, issuedAt: n.body.issuedAt }
      const r = await call("/api/trade-block", { method: "POST", body: JSON.stringify({ action: "wallet", proof: signed }) })
      if (!r.ok || !Array.isArray(r.body?.accounts)) throw new Error(errorOf(r))
      const list = r.body.accounts as Account[]
      setProof(signed)
      if (list.length === 1) await save(signed, list[0].address)
      else setAccounts(list)
    } catch (e) {
      setErr(`Flow Wallet: ${errorText(e)}`)
    } finally {
      setConnecting(false)
    }
  }

  return (
    <section style={card}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, margin: "0 0 8px" }}>Your proven accounts</h2>
      {wallets.length === 0 ? (
        <p style={{ ...muted, margin: "0 0 8px" }}>None yet. Prove the account your assets sit in before you post or propose.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 8px", fontFamily: MONO, fontSize: 12 }}>
          {wallets.map((w) => (
            <li key={w.source}>
              {shortAddr(w.source)} · proved with {shortAddr(w.signer)}
              {w.proven_at ? ` · ${ptDate(w.proven_at)}` : ""}
            </li>
          ))}
        </ul>
      )}
      <button type="button" style={wallets.length ? btn : btnPrimary} onClick={connect} disabled={connecting}>
        {connecting ? "Waiting for Flow Wallet…" : wallets.length ? "Prove another account" : "Connect Flow Wallet"}
      </button>
      <p style={{ ...muted, fontSize: 12, margin: "6px 0 0" }}>
        Your Flow Wallet signs a sign-in (no fee) so RPC knows it&apos;s yours; a Dapper account linked to it counts too. Nothing is signed or moved from this page.
      </p>
      {accounts ? (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={label}>Which account holds your assets?</div>
          {accounts.map((a) => (
            <button key={a.address} type="button" style={{ ...btn, textAlign: "left" }} onClick={() => proof && void save(proof, a.address)}>
              {a.name ?? (a.role === "flow_wallet" ? "Flow Wallet" : a.dapper ? "Dapper account" : "Linked account")} · {shortAddr(a.address)}
            </button>
          ))}
        </div>
      ) : null}
      {err ? <p style={{ color: "var(--rpc-danger-text)", fontSize: 13, margin: "8px 0 0" }}>{err}</p> : null}
    </section>
  )
}

// ── 2 · composer ─────────────────────────────────────────────────────────────

type Want =
  | { kind: "edition"; collection_id: string; edition_key: string; label: string }
  | { kind: "player"; collection_id: string; player_name: string; label: string }

type Holdings = { kind: "idle" } | { kind: "loading" } | { kind: "error"; error: string } | { kind: "ok"; indexed: boolean; rows: Holding[]; truncated: boolean }
type EditionHit = { id: string; external_id: string | null; player_name: string | null; set_name: string | null; tier: string | null; collection_id: string | null }

const hkey = (h: { collection_id: string; moment_id: string }) => `${h.collection_id}:${h.moment_id}`
const OFFERABLE = BLOCK_COLLECTIONS.filter((c) => c.offerable)

function Composer({ onPosted, setMsg }: { onPosted: () => void; setMsg: (s: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const [collection, setCollection] = useState("")
  const [q, setQ] = useState("")
  const [holdings, setHoldings] = useState<Holdings>({ kind: "idle" })
  const [offers, setOffers] = useState<Map<string, Holding>>(new Map())
  const [wants, setWants] = useState<Want[]>([])
  const [note, setNote] = useState("")
  const [openToOffers, setOpenToOffers] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const readHoldings = useCallback(async (c: string, query: string) => {
    setHoldings({ kind: "loading" })
    const sp = new URLSearchParams({ holdings: "1" })
    if (c) sp.set("collection", c)
    if (query.trim()) sp.set("q", query.trim())
    const r = await call(`/api/trade-block?${sp.toString()}`)
    const h = r.body?.holdings as { indexed?: boolean; rows?: Holding[]; truncated?: boolean } | undefined
    if (!r.ok || !h || !Array.isArray(h.rows)) return setHoldings({ kind: "error", error: r.ok ? "The response had no holdings in it." : errorOf(r) })
    setHoldings({ kind: "ok", indexed: h.indexed === true, rows: h.rows, truncated: h.truncated === true })
  }, [])

  const lines = useMemo(() => (holdings.kind === "ok" ? holdings.rows.map((h) => lineView({ ...h, kind: "moment" }, undefined)) : []), [holdings])
  const chosen = useMemo(() => [...offers.values()].map((h) => lineView({ ...h, kind: "moment" }, undefined)), [offers])

  const toggle = (h: Holding) => {
    const next = new Map(offers)
    const k = hkey(h)
    if (next.has(k)) next.delete(k)
    else if (next.size < MAX_LINES_PER_SIDE) next.set(k, h)
    else return setErr(`At most ${MAX_LINES_PER_SIDE} assets per listing.`)
    setOffers(next)
  }

  const post = async () => {
    setErr(null)
    setBusy(true)
    const body = {
      action: "create",
      offers: [...offers.values()].map((h) => ({ collection_id: h.collection_id, moment_id: h.moment_id })),
      wants: wants.map((w) => (w.kind === "edition" ? { kind: w.kind, collection_id: w.collection_id, edition_key: w.edition_key } : { kind: w.kind, collection_id: w.collection_id, player_name: w.player_name })),
      note: note.trim() || null,
      open_to_offers: openToOffers,
    }
    const r = await call("/api/trade-block", { method: "POST", body: JSON.stringify(body) })
    setBusy(false)
    if (!r.ok) return setErr(errorOf(r))
    const code = (r.body?.listing as { code?: string } | undefined)?.code
    setOffers(new Map())
    setWants([])
    setNote("")
    setOpen(false)
    setMsg(code ? `Posted. Your listing is live at /trades/block/${code}.` : "Posted.")
    onPosted()
  }

  if (!open) {
    return (
      <section style={card}>
        <button
          type="button"
          style={btnPrimary}
          onClick={() => {
            setOpen(true)
            void readHoldings("", "")
          }}
        >
          Post a listing
        </button>
      </section>
    )
  }

  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, margin: 0 }}>New listing</h2>

      <div>
        <div style={label}>You&apos;d trade ({offers.size})</div>
        <LineList lines={chosen} empty="Pick assets below." />
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void readHoldings(collection, q)
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}
        >
          <select value={collection} onChange={(e) => setCollection(e.target.value)} aria-label="Collection" style={input}>
            <option value="">All my collections</option>
            {OFFERABLE.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.label}
              </option>
            ))}
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Player, character or set" aria-label="Filter your assets" style={{ ...input, flex: "1 1 160px" }} />
          <button type="submit" style={btn}>
            Filter
          </button>
        </form>
        {holdings.kind === "loading" || holdings.kind === "idle" ? (
          <p style={muted}>Loading your assets…</p>
        ) : holdings.kind === "error" ? (
          <p style={{ color: "var(--rpc-danger-text)", fontSize: 13 }}>Couldn&apos;t load your assets: {holdings.error}</p>
        ) : !holdings.indexed ? (
          <p style={{ ...muted, fontSize: 13 }}>RPC hasn&apos;t indexed the accounts you proved yet. That says nothing about what they hold — try again later.</p>
        ) : lines.length === 0 ? (
          <p style={muted}>Nothing matches that filter.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 420, overflowY: "auto" }}>
            {holdings.rows.map((h, i) => (
              <Line key={hkey(h)} line={lines[i]} selected={offers.has(hkey(h))} onToggle={() => toggle(h)} />
            ))}
          </div>
        )}
        {holdings.kind === "ok" && holdings.truncated ? <p style={{ ...muted, fontSize: 12 }}>Showing your 500 highest-valued assets — filter to find others.</p> : null}
      </div>

      <WantsEditor wants={wants} setWants={setWants} setErr={setErr} />

      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        <input type="checkbox" checked={openToOffers} onChange={(e) => setOpenToOffers(e.target.checked)} />
        Open to other offers too
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={label}>Note (optional)</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
          rows={2}
          placeholder="What you're after, in your words. No links, contact handles or cash."
          style={input}
        />
      </label>

      {err ? <p style={{ color: "var(--rpc-danger-text)", fontSize: 13, margin: 0 }}>{err}</p> : null}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={btnPrimary} onClick={post} disabled={busy || offers.size === 0}>
          {busy ? "Posting…" : "Post listing"}
        </button>
        <button type="button" style={btn} onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      <p style={{ ...muted, fontSize: 12, margin: 0 }}>Listings stay up for 30 days. Anyone can see them; nobody sees your wallet addresses.</p>
    </section>
  )
}

function WantsEditor({ wants, setWants, setErr }: { wants: Want[]; setWants: (w: Want[]) => void; setErr: (s: string | null) => void }) {
  const [mode, setMode] = useState<"edition" | "player">("edition")
  const [q, setQ] = useState("")
  const [hits, setHits] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "error"; error: string } | { kind: "ok"; rows: EditionHit[] }>({ kind: "idle" })
  const [pc, setPc] = useState(BLOCK_COLLECTIONS[0].id)
  const [name, setName] = useState("")

  const add = (w: Want) => {
    if (wants.length >= MAX_LINES_PER_SIDE) return setErr(`At most ${MAX_LINES_PER_SIDE} wants per listing.`)
    if (wants.some((x) => x.label === w.label && x.collection_id === w.collection_id)) return
    setWants([...wants, w])
  }

  const search = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!q.trim()) return
    setHits({ kind: "loading" })
    const r = await call(`/api/edition-search?q=${encodeURIComponent(q.trim())}`)
    if (!r.ok || !Array.isArray(r.body?.results)) return setHits({ kind: "error", error: r.ok ? "No results in the response." : errorOf(r) })
    setHits({ kind: "ok", rows: (r.body.results as EditionHit[]).filter((h) => h.collection_id && BLOCK_COLLECTIONS.some((c) => c.id === h.collection_id)) })
  }

  const collectionLabel = (id: string | null) => BLOCK_COLLECTIONS.find((c) => c.id === id)?.label ?? ""
  const person = BLOCK_COLLECTIONS.find((c) => c.id === pc)?.person ?? "player"

  return (
    <div>
      <div style={label}>You want back ({wants.length})</div>
      {wants.length === 0 ? (
        <p style={{ ...muted, margin: "4px 0" }}>Nothing named yet — add editions or players, or leave it open to offers.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "4px 0", display: "flex", flexDirection: "column", gap: 4 }}>
          {wants.map((w, i) => (
            <li key={`${w.collection_id}:${w.label}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
              <span>
                {w.label} <span style={muted}>· {collectionLabel(w.collection_id)}</span>
              </span>
              <button type="button" style={{ ...btn, padding: "1px 8px", fontSize: 11 }} onClick={() => setWants(wants.filter((_, j) => j !== i))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: "flex", gap: 8, margin: "6px 0" }}>
        <button type="button" style={{ ...btn, opacity: mode === "edition" ? 1 : 0.6 }} onClick={() => setMode("edition")} aria-pressed={mode === "edition"}>
          A specific edition
        </button>
        <button type="button" style={{ ...btn, opacity: mode === "player" ? 1 : 0.6 }} onClick={() => setMode("player")} aria-pressed={mode === "player"}>
          Any of a player or character
        </button>
      </div>
      {mode === "edition" ? (
        <>
          <form onSubmit={search} style={{ display: "flex", gap: 8 }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search editions by player" aria-label="Search editions" style={{ ...input, flex: 1 }} />
            <button type="submit" style={btn}>
              Search
            </button>
          </form>
          {hits.kind === "loading" ? (
            <p style={muted}>Searching…</p>
          ) : hits.kind === "error" ? (
            <p style={{ color: "var(--rpc-danger-text)", fontSize: 13 }}>Couldn&apos;t search: {hits.error}</p>
          ) : hits.kind === "ok" ? (
            hits.rows.length === 0 ? (
              <p style={muted}>No editions match. For Disney Pinnacle, add a character instead.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0", display: "flex", flexDirection: "column", gap: 4 }}>
                {hits.rows.map((h) => {
                  const lbl = [h.player_name, h.set_name, h.tier ? h.tier.charAt(0) + h.tier.slice(1).toLowerCase() : null].filter(Boolean).join(" · ")
                  return (
                    <li key={h.id}>
                      <button
                        type="button"
                        style={{ ...btn, textAlign: "left", width: "100%" }}
                        onClick={() => add({ kind: "edition", collection_id: h.collection_id as string, edition_key: h.external_id ?? h.id, label: lbl || "Edition" })}
                      >
                        + {lbl} <span style={muted}>· {collectionLabel(h.collection_id)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )
          ) : null}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const n = name.replace(/\s+/g, " ").trim()
            if (n.length < 2) return
            add({ kind: "player", collection_id: pc, player_name: n, label: `Any ${n}` })
            setName("")
          }}
          style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
        >
          <select value={pc} onChange={(e) => setPc(e.target.value)} aria-label="Collection" style={input}>
            {BLOCK_COLLECTIONS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} placeholder={`${person.charAt(0).toUpperCase()}${person.slice(1)} name`} aria-label={`${person} name`} style={{ ...input, flex: "1 1 160px" }} />
          <button type="submit" style={btn}>
            Add
          </button>
        </form>
      )}
    </div>
  )
}

// ── 3 · listings ─────────────────────────────────────────────────────────────

function Listings({ listings, onUpdate }: { listings: ListingView[]; onUpdate: (r: Called) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const close = async (code: string) => {
    setBusy(code)
    setErr(null)
    const r = await call("/api/trade-block", { method: "POST", body: JSON.stringify({ action: "close", code }) })
    setBusy(null)
    if (!r.ok) return setErr(errorOf(r))
    onUpdate(r)
  }
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, margin: 0 }}>Your listings</h2>
      {err ? <p style={{ color: "var(--rpc-danger-text)", fontSize: 13, margin: 0 }}>{err}</p> : null}
      {listings.length === 0 ? (
        <p style={{ ...muted, margin: 0 }}>No listings yet.</p>
      ) : (
        listings.map((l) => (
          <div key={l.code} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <ListingCard l={l} href={`/trades/block/${l.code}`} />
            {l.state === "open" ? (
              <button type="button" style={{ ...btn, alignSelf: "flex-start" }} disabled={busy !== null} onClick={() => void close(l.code)}>
                {busy === l.code ? "Closing…" : "Close listing"}
              </button>
            ) : null}
          </div>
        ))
      )}
    </section>
  )
}

// ── 4 · proposals ────────────────────────────────────────────────────────────

const STATUS: Record<ProposalView["status"], string> = { pending: "Waiting for an answer", accepted: "Accepted", declined: "Declined", withdrawn: "Withdrawn" }

function Proposals({ title, list, onUpdate, setMsg }: { title: string; list: ProposalView[]; onUpdate: (r: Called) => void; setMsg: (s: string | null) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const act = async (body: Record<string, unknown>, code: string) => {
    setBusy(code)
    setErr(null)
    const r = await call("/api/trade-block", { method: "POST", body: JSON.stringify(body) })
    setBusy(null)
    if (!r.ok) return setErr(errorOf(r))
    if (body.action === "decide" && body.accept === true) {
      const room = r.body?.room_code
      setMsg(typeof room === "string" ? `Accepted — a trade room is open: /trades/${room}. Both of you prove a wallet and pick the same Moments there.` : "Accepted. Signing isn't available on RPC for every collection in this trade yet, so nothing moves from here.")
    }
    onUpdate(r)
  }
  if (list.length === 0 && title.startsWith("Proposals you sent")) return null
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, margin: 0 }}>{title}</h2>
      {err ? <p style={{ color: "var(--rpc-danger-text)", fontSize: 13, margin: 0 }}>{err}</p> : null}
      {list.length === 0 ? (
        <p style={{ ...muted, margin: 0 }}>None yet.</p>
      ) : (
        list.map((p) => {
          const received = p.direction === "received"
          return (
            <div key={p.code} style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 15 }}>
                  {received ? `From ${p.counterparty}` : `To ${p.counterparty}`}
                </div>
                <div style={{ ...muted, fontSize: 12 }}>
                  {STATUS[p.status]} · {ptDate(p.created_at)}
                  {p.listing_code ? (
                    <>
                      {" · "}
                      <Link href={`/trades/block/${p.listing_code}`}>listing</Link>
                    </>
                  ) : null}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginTop: 8 }}>
                <div>
                  <div style={label}>
                    {received ? `${p.counterparty} gives` : "You give"} · {valueLine(p.give_value, fmtUsd)}
                  </div>
                  <LineList lines={p.give} empty="Nothing." />
                </div>
                <div>
                  <div style={label}>
                    {received ? "You give" : `${p.counterparty} gives`} · {valueLine(p.get_value, fmtUsd)}
                  </div>
                  <LineList lines={p.get} empty="Nothing." />
                </div>
              </div>
              {p.note ? <p style={{ fontSize: 13, margin: "8px 0 0" }}>&ldquo;{p.note}&rdquo;</p> : null}
              {p.status === "accepted" ? (
                p.room_code ? (
                  <p style={{ fontSize: 13, margin: "8px 0 0" }}>
                    <Link href={`/trades/${p.room_code}`}>Open the trade room →</Link> Both of you prove a wallet and pick the same Moments there; nothing moves until both sign.
                  </p>
                ) : (
                  <p style={{ ...muted, fontSize: 13, margin: "8px 0 0" }}>
                    Agreed. Signing on RPC is NBA Top Shot only for now{p.unsignable.length ? ` — ${p.unsignable.join(", ")} ${p.unsignable.length === 1 ? "isn't" : "aren't"} supported yet` : ""}, so nothing moves from here.
                  </p>
                )
              ) : null}
              {p.status === "pending" ? (
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  {received ? (
                    <>
                      <button type="button" style={btnPrimary} disabled={busy !== null} onClick={() => void act({ action: "decide", proposal: p.code, accept: true }, p.code)}>
                        {busy === p.code ? "Working…" : "Accept"}
                      </button>
                      <button type="button" style={btn} disabled={busy !== null} onClick={() => void act({ action: "decide", proposal: p.code, accept: false }, p.code)}>
                        Decline
                      </button>
                      {p.unsignable.length ? (
                        <span style={{ ...muted, fontSize: 12, alignSelf: "center" }}>
                          {p.unsignable.join(", ")} can&apos;t be signed on RPC yet — accepting records the agreement only.
                        </span>
                      ) : (
                        <span style={{ ...muted, fontSize: 12, alignSelf: "center" }}>All NBA Top Shot — accepting opens a trade room for the two of you.</span>
                      )}
                    </>
                  ) : (
                    <button type="button" style={btn} disabled={busy !== null} onClick={() => void act({ action: "withdraw", proposal: p.code }, p.code)}>
                      {busy === p.code ? "Working…" : "Withdraw"}
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          )
        })
      )}
    </section>
  )
}
