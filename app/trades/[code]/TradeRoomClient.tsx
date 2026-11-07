"use client"

// app/trades/[code]/TradeRoomClient.tsx
//
// One trade room, as either side sees it. The steps, top to bottom:
//   1. join (a stranger with the link becomes side B);
//   2. prove a Flow Wallet (FCL account proof at connect) and pick the account the
//      Moments sit in — the wallet itself, or a Dapper account it links;
//   3. pick Moments to give — NBA Top Shot, NFL All Day, LaLiga Golazos and UFC Strike, in any mix
//      (2026-11-02) — chain-checked on save: held, and for Top Shot unlocked;
//   4. read the notice and accept the proposal AS SEEN (any change resets both);
//   5. once both accepted: simulate on mainnet, then the initiator's wallet signs and
//      the other side's wallet co-signs through the relay — ⛔ that last step is gated
//      by RPC_TRADE_ROOM_EXECUTE (execution.open; open since 2026-10-31 — the kill switch).
// Every empty state is gated on a successful read; a failed read is a banner with
// Retry, never "no Moments" or "not held". RPC never holds a Moment or a key.

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { errorText } from "@/lib/giveaways/view-format"
import type { PickerResult } from "@/lib/trade-room/holdings"
import type { SwapPlan } from "@/lib/swap-test/plan"
import type { MultiPlan } from "@/lib/trade-room/multi-plan"
import { waitForRelaySignature } from "@/lib/swap-test/view"
import { describeRoomSignable } from "@/lib/trade-room/signable"
import { SWAP_COLLECTIONS, swapCollectionByDbSlug, type SwapSlug } from "@/lib/trade-room/multi-swap-cadence"
import type { ItemView, RoomView, SideView } from "@/lib/trade-room/view"
import { MAX_ITEMS_PER_SIDE } from "@/lib/trade-room/valuation"
import { btn, btnPrimary, call, card, DISPLAY, errorOf, fmtUsd, label, MONO, muted, shortAddr, stateLabel, type Called } from "../trade-ui"
import { onTablistKeyDown } from "@/lib/a11y/tablist-keys"

type Account = { address: string; role: "flow_wallet" | "linked"; name: string | null; dapper: boolean; topshot_count: number | null }
type Proof = { address: string; nonce: string; signatures: unknown[]; issuedAt: string }
type Load = { kind: "loading" } | { kind: "error"; error: string; status: number } | { kind: "ok"; room: RoomView }

async function fetchRoom(api: string): Promise<Load> {
  const r = await call(api)
  if (!r.ok || !r.body?.room) return { kind: "error", error: errorOf(r), status: r.status }
  return { kind: "ok", room: r.body.room as RoomView }
}

// The page's only wallet code, loaded on demand (it pulls in FCL). Loading it when
// the room mounts, not at click time, lets FCL register WalletConnect before the
// picker opens, so Flow Wallet's mobile app is listed.
const loadWallet = () => import("@/lib/trade-room/trade-wallet")

const LIVE = new Set(["open", "building", "accepted", "signing"])

/** A pick's identity: moment ids are unique only within a collection. */
const keyOf = (i: { collection: string; moment_id: string }) => `${i.collection}:${i.moment_id}`
const SHORT_LABEL: Record<string, string> = Object.fromEntries(SWAP_COLLECTIONS.map((c) => [c.dbSlug, c.short]))
const POLL_MS = 5_000

export default function TradeRoomClient({ code }: { code: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const api = `/api/trade-room/${encodeURIComponent(code)}`

  const read = useCallback(() => fetchRoom(api).then(setLoad), [api])

  // Which collections each side's account can RECEIVE, read from the chain (2026-11-03). Re-read
  // whenever a side's account changes; a failed read says so, never "can't receive".
  const [receive, setReceive] = useState<{ kind: "idle" } | { kind: "ok"; by: Record<"a" | "b", Record<string, boolean> | null> } | { kind: "error" }>({ kind: "idle" })
  const sourcesKey = load.kind === "ok" ? `${load.room.a.source ?? ""}|${load.room.b?.source ?? ""}` : ""
  const inRoom = load.kind === "ok" && load.room.me !== null
  useEffect(() => {
    if (!inRoom || sourcesKey === "|") return
    let live = true
    void call(`${api}?receive=1`).then((r) => {
      if (!live) return
      if (r.ok && r.body?.receive) setReceive({ kind: "ok", by: r.body.receive as Record<"a" | "b", Record<string, boolean> | null> })
      else setReceive({ kind: "error" })
    })
    return () => {
      live = false
    }
  }, [api, sourcesKey, inRoom])

  useEffect(() => {
    let live = true
    void fetchRoom(api).then((l) => {
      if (live) setLoad(l)
    })
    void loadWallet().catch(() => undefined)
    return () => {
      live = false
    }
  }, [api])

  // live rooms poll (the other side's picks and acceptance arrive this way); a
  // finished room does not
  useEffect(() => {
    if (load.kind !== "ok" || !LIVE.has(load.room.state)) return
    const t = setInterval(() => void read(), POLL_MS)
    return () => clearInterval(t)
  }, [load, read])

  /** Runs an action; on success the route returns the fresh room. */
  const act = useCallback(
    async (name: string, body: Record<string, unknown>, ok?: (r: Called) => void): Promise<Called> => {
      setBusy(name)
      setErr(null)
      setMsg(null)
      const r = await call(api, { method: "POST", body: JSON.stringify({ action: name, ...body }) })
      setBusy(null)
      if (!r.ok) setErr(errorOf(r))
      else {
        if (r.body?.room) setLoad({ kind: "ok", room: r.body.room as RoomView })
        ok?.(r)
      }
      return r
    },
    [api],
  )

  if (load.kind === "loading") return <Shell code={code}><p style={muted}>Loading the trade…</p></Shell>
  if (load.kind === "error") {
    return (
      <Shell code={code}>
        <section style={{ ...card, borderColor: "var(--rpc-danger-text)" }}>
          <p style={{ margin: "0 0 8px", color: "var(--rpc-danger-text)", fontSize: 13 }}>
            {load.status === 404 ? "No such trade — the link may be wrong, or the trade isn't open to you." : `Couldn't load this trade: ${load.error}`}
          </p>
          <button type="button" style={btn} onClick={read}>
            Retry
          </button>
        </section>
      </Shell>
    )
  }

  const room = load.room
  const me = room.me
  const receiveFor = (side: SideView | null) => (side && receive.kind === "ok" ? receive.by[side.side] : null)
  const mine = me ? (me.side === "a" ? room.a : room.b) : null
  const theirs = me ? (me.side === "a" ? room.b : room.a) : room.a
  const live = LIVE.has(room.state)
  const editable = room.state === "open" || room.state === "building" || room.state === "accepted"

  return (
    <Shell code={code}>
      <section style={{ ...card, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 18 }}>{stateLabel(room.state)}</div>
          <div style={{ ...muted, fontFamily: MONO, fontSize: 12 }}>
            {room.a.username} ↔ {room.b ? room.b.username : "waiting for the other side"} · v{room.version} · expires{" "}
            {new Date(room.expires_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT
          </div>
        </div>
        {room.state === "open" && me ? <InviteLink code={code} /> : null}
        {room.can_join ? (
          <button type="button" style={btnPrimary} disabled={busy !== null} onClick={() => act("join", {})}>
            Join this trade
          </button>
        ) : null}
      </section>

      {room.from_block && room.state !== "sealed" ? <FromBlockPanel room={room} /> : null}

      {room.state === "cancelled" ? (
        <p style={muted}>
          Cancelled{room.cancelled_by_me ? " by you" : ""}
          {room.cancel_reason ? `: ${room.cancel_reason}` : "."}
        </p>
      ) : null}
      {room.state === "expired" ? <p style={muted}>This trade expired before both sides signed. Start a new one.</p> : null}
      {room.state === "sealed" ? <Sealed room={room} busy={busy} act={act} /> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))", gap: 16 }}>
        {mine ? (
          <MySide room={room} side={mine} api={api} editable={editable} busy={busy} act={act} setErr={setErr} setMsg={setMsg} receive={receiveFor(mine)} receiveFailed={receive.kind === "error"} />
        ) : null}
        <TheirSide side={theirs} room={room} receive={receiveFor(theirs)} receiveFailed={receive.kind === "error"} />
      </div>

      <FairTrade room={room} />

      {me && mine && live && room.state !== "open" ? (
        <Accept room={room} side={mine} busy={busy} act={act} />
      ) : null}

      {me && mine && (room.state === "accepted" || room.state === "signing") ? (
        <Execute room={room} side={mine} api={api} busy={busy} setBusy={setBusy} act={act} setErr={setErr} setMsg={setMsg} reload={read} />
      ) : null}

      {msg ? <p style={{ fontSize: 13 }}>{msg}</p> : null}
      {err ? <p style={{ color: "var(--rpc-danger-text)", fontSize: 13 }}>{err}</p> : null}

      {me && live ? (
        <div>
          <button type="button" style={btn} disabled={busy !== null} onClick={() => act("cancel", {})}>
            Cancel this trade
          </button>
        </div>
      ) : null}
    </Shell>
  )
}

function Shell({ code, children }: { code: string; children: React.ReactNode }) {
  return (
    <main id="content" style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px 80px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <Link href="/trades" style={{ color: "var(--rpc-text-muted)", fontSize: 13 }}>
          ← Trades
        </Link>
        <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: "8px 0 0", fontSize: 24 }}>
          Trade <span style={{ fontFamily: MONO, fontSize: 14, color: "var(--rpc-text-muted)" }}>{code}</span>
        </h1>
      </div>
      {children}
    </main>
  )
}

function InviteLink({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const link = typeof window !== "undefined" ? `${window.location.origin}/trades/${code}` : `/trades/${code}`
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ ...muted, fontFamily: MONO, fontSize: 12, wordBreak: "break-all" }}>{link}</span>
      <button
        type="button"
        style={btn}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          } catch {
            setCopied(false)
          }
        }}
      >
        {copied ? "Copied" : "Copy invite link"}
      </button>
      <span style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>You get an email when they join, accept or cancel.</span>
    </div>
  )
}

type Act = (name: string, body: Record<string, unknown>, ok?: (r: Called) => void) => Promise<Called>

function MySide({
  room,
  side,
  api,
  editable,
  busy,
  act,
  setErr,
  setMsg,
  receive,
  receiveFailed,
}: {
  room: RoomView
  side: SideView
  api: string
  editable: boolean
  busy: string | null
  act: Act
  setErr: (s: string | null) => void
  setMsg: (s: string | null) => void
  receive: Record<string, boolean> | null
  receiveFailed: boolean
}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [proof, setProof] = useState<Proof | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [picker, setPicker] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "error"; error: string } | { kind: "ok"; result: PickerResult }>({ kind: "idle" })
  const [q, setQ] = useState("")
  const [picked, setPicked] = useState<Set<string>>(new Set(side.items.map(keyOf)))
  const [showPicker, setShowPicker] = useState(false)
  const [coll, setColl] = useState<SwapSlug>("nba-top-shot")
  const savedIds = useRef(side.items.map(keyOf).join(","))

  // the saved picks changed under us (a source change cleared them): resync
  useEffect(() => {
    const now = side.items.map(keyOf).join(",")
    if (now !== savedIds.current) {
      savedIds.current = now
      setPicked(new Set(side.items.map(keyOf)))
    }
  }, [side.items])

  const connect = async () => {
    setConnecting(true)
    setErr(null)
    try {
      const n = await call(`${api}?nonce=1`)
      if (!n.ok || typeof n.body?.nonce !== "string" || typeof n.body?.issuedAt !== "string") throw new Error(errorOf(n))
      const w = await loadWallet()
      const connected = await w.connectTradeWalletWithProof(n.body.nonce)
      if (!connected.proof) throw new Error("Your wallet didn't send the sign-in that proves it's yours. Update Flow Wallet and try again.")
      const signed: Proof = { ...connected.proof, issuedAt: n.body.issuedAt }
      const r = await act("wallet", { proof: signed })
      if (r.ok && Array.isArray(r.body?.accounts)) {
        const list = r.body.accounts as Account[]
        setProof(signed)
        setAccounts(list)
        // one account: no need to ask. With several the user picks where the Moments they'll
        // give sit (any of Top Shot / All Day / Golazos / UFC may live in either)
        if (list.length === 1) await act("wallet", { proof: signed, source: list[0].address }, () => setAccounts(null))
      }
    } catch (e) {
      setErr(`Flow Wallet: ${errorText(e)}`)
    } finally {
      setConnecting(false)
    }
  }

  const choose = async (source: string) => {
    if (!proof) return
    await act("wallet", { proof, source }, () => setAccounts(null))
  }

  const openPicker = useCallback(
    async (query: string, collection: SwapSlug) => {
      setPicker({ kind: "loading" })
      const r = await call(`${api}?picker=1&collection=${encodeURIComponent(collection)}&q=${encodeURIComponent(query)}`)
      if (!r.ok || !r.body?.picker) setPicker({ kind: "error", error: errorOf(r) })
      else setPicker({ kind: "ok", result: r.body.picker as PickerResult })
    },
    [api],
  )

  const toggle = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else if (next.size < MAX_ITEMS_PER_SIDE) next.add(id)
    else return setErr(`At most ${MAX_ITEMS_PER_SIDE} Moments per side.`)
    setPicked(next)
  }

  const save = async () => {
    const picks = [...picked].map((k) => {
      const [db, id] = k.split(":")
      return { collection: swapCollectionByDbSlug(db)?.slug ?? db, id }
    })
    await act("items", { picks }, () => {
      setShowPicker(false)
      setMsg("Picks saved and checked on chain: held, and Top Shot ones unlocked.")
    })
  }

  return (
    <section style={card}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, margin: "0 0 8px" }}>
        You give <span style={{ color: "var(--rpc-text-muted)" }}>({side.username})</span>
      </h2>

      {/* 1 · wallet */}
      <div style={{ marginBottom: 10 }}>
        <div style={label}>Flow Wallet</div>
        {side.proven ? (
          <div style={{ fontFamily: MONO, fontSize: 12 }}>
            {shortAddr(side.signer)} signs · Moments from {shortAddr(side.source)}
            <CanReceive receive={receive} failed={receiveFailed} mine />
            {editable ? (
              <button type="button" style={{ ...btn, marginLeft: 8, padding: "2px 8px", fontSize: 11 }} disabled={connecting || busy !== null} onClick={connect}>
                Change
              </button>
            ) : null}
          </div>
        ) : editable ? (
          <div>
            <button type="button" style={btnPrimary} disabled={connecting || busy !== null} onClick={connect}>
              {connecting ? "Waiting for Flow Wallet…" : "Connect Flow Wallet"}
            </button>
            <p style={{ ...muted, fontSize: 12, margin: "6px 0 0" }}>
              Your wallet signs a sign-in (no fee) so we know it&apos;s yours. Moments in a Dapper account linked to it can be traded too.
            </p>
          </div>
        ) : (
          <div style={muted}>No wallet proven.</div>
        )}
        {accounts ? (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={label}>Which account holds the Moments you&apos;ll give?</div>
            {accounts.map((a) => (
              <button
                key={a.address}
                type="button"
                style={{ ...btn, textAlign: "left" }}
                disabled={busy !== null}
                onClick={() => choose(a.address)}
              >
                {a.name ?? (a.role === "flow_wallet" ? "Flow Wallet" : a.dapper ? "Dapper account" : "Linked account")} · {shortAddr(a.address)}
                {a.topshot_count != null ? ` · ${a.topshot_count} Top Shot Moments` : ""}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* 2 · picks */}
      <div>
        <div style={label}>Moments you give ({side.items.length})</div>
        <ItemList items={side.items} empty="Nothing yet." />
        {editable && side.proven ? (
          <div style={{ marginTop: 8 }}>
            {!showPicker ? (
              <button
                type="button"
                style={btn}
                disabled={busy !== null}
                onClick={() => {
                  setShowPicker(true)
                  void openPicker(q, coll)
                }}
              >
                {side.items.length ? "Change picks" : "Pick Moments"}
              </button>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div role="tablist" onKeyDown={onTablistKeyDown} tabIndex={-1} aria-label="Collection" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {SWAP_COLLECTIONS.map((c) => (
                    <button
                      key={c.slug}
                      type="button"
                      role="tab"
                      aria-selected={coll === c.slug}
                      style={{ ...btn, padding: "4px 10px", fontSize: 12, ...(coll === c.slug ? { borderColor: "var(--rpc-red-text)", color: "var(--rpc-red-text)" } : {}) }}
                      onClick={() => {
                        setColl(c.slug)
                        void openPicker(q, c.slug)
                      }}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    void openPicker(q, coll)
                  }}
                  style={{ display: "flex", gap: 6 }}
                >
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Filter by player"
                    aria-label="Filter by player"
                    style={{ flex: 1, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--rpc-border)", background: "var(--rpc-bg)", color: "var(--rpc-text-primary)", fontFamily: MONO, fontSize: 13 }}
                  />
                  <button type="submit" style={btn}>
                    Filter
                  </button>
                </form>
                {picker.kind === "loading" ? (
                  <p style={muted}>Reading your Moments…</p>
                ) : picker.kind === "error" ? (
                  <p style={{ color: "var(--rpc-danger-text)", fontSize: 13 }}>
                    Couldn&apos;t read your Moments: {picker.error}{" "}
                    <button type="button" style={{ ...btn, padding: "2px 8px", fontSize: 11 }} onClick={() => openPicker(q, coll)}>
                      Retry
                    </button>
                  </p>
                ) : picker.kind === "ok" ? (
                  !picker.result.indexed ? (
                    <p style={muted}>
                      RPC hasn&apos;t indexed that account yet. Add it on your <Link href="/dashboard">dashboard</Link> first, then come back.
                    </p>
                  ) : picker.result.no_collection ? (
                    <p style={muted}>This account has no {SWAP_COLLECTIONS.find((c) => c.slug === coll)?.label ?? ""} collection on chain, so it has nothing of that kind to give.</p>
                  ) : picker.result.rows.length === 0 ? (
                    <>
                      <p style={muted}>{q.trim() ? "No Moments match that filter." : `No ${SWAP_COLLECTIONS.find((c) => c.slug === coll)?.label ?? ""} Moments in this account can be traded right now.`}</p>
                      {!q.trim() && picker.result.not_in_collection ? <p style={{ ...muted, fontSize: 12 }}>{picker.result.not_in_collection} that RPC lists for it {picker.result.not_in_collection === 1 ? "isn't" : "aren't"} in its on-chain collection (locked, or held by Dapper).</p> : null}
                      {!q.trim() && picker.result.unindexed_held ? <p style={{ ...muted, fontSize: 12 }}>{picker.result.unindexed_held} in this account RPC hasn&apos;t indexed yet.</p> : null}
                    </>
                  ) : (
                    <>
                      <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: 320, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                        {picker.result.rows.map((r) => {
                          // #222: "live" = read from the chain just now; a live lock or a moment the
                          // account no longer holds can't be traded, so it isn't pickable. A cached
                          // hint is shown as such and stays pickable (the save re-reads the chain).
                          const live = picker.result.lock_state === "live"
                          const gone = live && r.held_live === false
                          const listed = live && r.listed_live === true
                          const blocked = live && (gone || r.locked_hint === true || listed)
                          const k = keyOf(r)
                          return (
                          <li key={k}>
                            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: blocked ? "not-allowed" : "pointer", opacity: blocked && !picked.has(k) ? 0.6 : 1 }}>
                              <input type="checkbox" checked={picked.has(k)} disabled={blocked && !picked.has(k)} onChange={() => toggle(k)} />
                              <span style={{ flex: 1 }}>
                                {momentLine(r)}
                                {gone ? (
                                  <span style={{ color: "var(--rpc-warning-text)" }}> · no longer in this account</span>
                                ) : r.locked_hint ? (
                                  <span style={{ color: "var(--rpc-warning-text)" }}>{live ? ` · locked on ${SHORT_LABEL[r.collection] ?? "chain"}` : " · locked (last check)"}</span>
                                ) : listed ? (
                                  <span style={{ color: "var(--rpc-warning-text)" }}> · listed for sale on Top Shot (cancel the listing to trade it)</span>
                                ) : null}
                              </span>
                              <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--rpc-text-muted)" }}>{r.priced && r.fmv_usd != null ? fmtUsd(r.fmv_usd) : "not priced"}</span>
                            </label>
                          </li>
                          )
                        })}
                      </ul>
                      {picker.result.truncated ? <p style={{ ...muted, fontSize: 12 }}>Showing the first {picker.result.rows.length}; filter by player to find others.</p> : null}
                      {picker.result.unindexed_held ? <p style={{ ...muted, fontSize: 12 }}>{picker.result.unindexed_held} more in this account RPC hasn&apos;t indexed yet, so they can&apos;t be picked until it has.</p> : null}
                      {picker.result.not_in_collection ? <p style={{ ...muted, fontSize: 12 }}>{picker.result.not_in_collection} Moment{picker.result.not_in_collection === 1 ? "" : "s"} RPC lists for this account {picker.result.not_in_collection === 1 ? "isn't" : "aren't"} in its on-chain collection right now (locked, or held by Dapper), so {picker.result.not_in_collection === 1 ? "it" : "they"} can&apos;t be traded.</p> : null}
                      {picker.result.lock_state === "cached" ? <p style={{ ...muted, fontSize: 12 }}>Couldn&apos;t read lock status from the chain just now, so locks shown are RPC&apos;s last check. Saving re-checks every pick on chain.</p> : null}
                    </>
                  )
                ) : null}
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" style={btnPrimary} disabled={busy !== null} onClick={save}>
                    {busy === "items" ? "Checking on chain…" : `Save ${picked.size} pick${picked.size === 1 ? "" : "s"}`}
                  </button>
                  <button type="button" style={btn} disabled={busy !== null} onClick={() => setShowPicker(false)}>
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
      {room.state === "accepted" ? <p style={{ ...muted, fontSize: 12, marginTop: 8 }}>Both sides accepted v{room.version}. Changing anything resets both acceptances.</p> : null}
    </section>
  )
}

/**
 * Which collections an account can receive (2026-11-03). A Dapper account that never held a
 * collection has none, and nothing RPC can sign creates it (Dapper's account linking gives a Flow
 * Wallet withdraw capabilities only) — so the line says where it is set up: on Dapper's side.
 */
function CanReceive({ receive, failed, mine = false }: { receive: Record<string, boolean> | null; failed: boolean; mine?: boolean }) {
  if (failed) return <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>Couldn&apos;t check which collections this account can receive just now.</div>
  if (!receive) return null
  const missing = SWAP_COLLECTIONS.filter((c) => receive[c.slug] === false)
  return (
    <div style={{ fontSize: 12, marginTop: 4, color: "var(--rpc-text-muted)" }} data-rpc-can-receive>
      Can receive: {SWAP_COLLECTIONS.map((c) => `${c.short} ${receive[c.slug] ? "✓" : "✗"}`).join(" · ")}
      {missing.length ? (
        <div style={{ marginTop: 2 }}>
          {mine ? "Your" : "Their"} account has no {missing.map((c) => c.label).join(" or ")} collection yet, so {missing.length === 1 ? "that" : "those"} can&apos;t be traded {mine ? "to you" : "to them"}. It&apos;s set up on Dapper&apos;s side (the account gets one when it holds a Moment of that collection); RPC can&apos;t create it.
        </div>
      ) : null}
    </div>
  )
}

function TheirSide({ side, room, receive, receiveFailed }: { side: SideView | null; room: RoomView; receive: Record<string, boolean> | null; receiveFailed: boolean }) {
  return (
    <section style={card}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, margin: "0 0 8px" }}>
        {side ? (
          <>
            {side.is_me ? "You" : side.username} give{side.is_me ? "" : "s"}
          </>
        ) : (
          "The other side"
        )}
      </h2>
      {!side ? (
        <p style={muted}>{room.state === "open" ? "Nobody has joined yet. Send them the invite link." : "No counterparty."}</p>
      ) : (
        <>
          <div style={{ ...muted, fontFamily: MONO, fontSize: 12, marginBottom: 8 }}>
            {side.proven ? `${shortAddr(side.signer)} signs · Moments from ${shortAddr(side.source)}` : "wallet not proven yet"} · {side.accepted ? `accepted v${room.version}` : "not accepted"}
            {side.proven ? <CanReceive receive={receive} failed={receiveFailed} mine={side.is_me} /> : null}
          </div>
          <ItemList items={side.items} empty="Nothing yet." />
        </>
      )}
    </section>
  )
}

function momentLine(i: Pick<ItemView, "player_name" | "set_name" | "serial_number" | "tier" | "series_number" | "moment_id"> & { collection?: string }): string {
  const tag = i.collection && i.collection !== "nba_top_shot" ? `${SHORT_LABEL[i.collection] ?? i.collection} · ` : ""
  const who = tag + (i.player_name ?? `Moment ${i.moment_id}`)
  const set = i.set_name ? ` · ${i.set_name}` : ""
  const serial = i.serial_number != null ? ` #${i.serial_number}` : ""
  const tier = i.tier ? ` · ${String(i.tier).toLowerCase()}` : ""
  return `${who}${set}${serial}${tier}`
}

function ItemList({ items, empty }: { items: ItemView[]; empty: string }) {
  if (items.length === 0) return <p style={{ ...muted, margin: 0 }}>{empty}</p>
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
      {items.map((i) => (
        <li key={keyOf(i)} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13 }}>
          <span>{momentLine(i)}</span>
          <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--rpc-text-muted)", whiteSpace: "nowrap" }}>{i.priced && i.fmv_usd != null ? fmtUsd(i.fmv_usd) : "not priced"}</span>
        </li>
      ))}
    </ul>
  )
}

function FairTrade({ room }: { room: RoomView }) {
  const v = room.valuation
  const sideLine = (name: string, s: typeof v.a) =>
    s.count === 0 ? `${name}: nothing` : `${name}: ${s.priced_total_usd != null ? fmtUsd(s.priced_total_usd) : "—"}${s.unpriced ? ` (${s.unpriced} of ${s.count} not priced)` : ""}`
  return (
    <section style={card}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, margin: "0 0 6px" }}>By RPC&apos;s FMV</h2>
      <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--rpc-text-muted)" }}>
        {sideLine(room.a.username, v.a)} · {sideLine(room.b?.username ?? "the other side", v.b)}
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 13 }}>{v.summary}</p>
      <p style={{ ...muted, fontSize: 12, margin: "6px 0 0" }}>
        A Moment reads &quot;not priced&quot; when it hasn&apos;t had enough sales for a confident value. This is a hint, not an appraisal: the trade is whatever you both agree to.
      </p>
    </section>
  )
}

function Accept({ room, side, busy, act }: { room: RoomView; side: SideView; busy: string | null; act: Act }) {
  const [read, setRead] = useState(room.me?.notice_read ?? false)
  const ready = room.b !== null && room.a.proven && room.b.proven && room.a.items.length + room.b.items.length > 0
  return (
    <section style={card}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, margin: "0 0 6px" }}>Accept</h2>
      <p style={{ fontSize: 13, margin: "0 0 8px" }}>{room.notice}</p>
      {side.accepted ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>You accepted v{room.version}.{room.state === "accepted" ? " Both sides have." : " Waiting for the other side — they get an email."}</span>
          {room.state !== "signing" ? (
            <button type="button" style={btn} disabled={busy !== null} onClick={() => act("unaccept", {})}>
              Withdraw
            </button>
          ) : null}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> I&apos;ve read this
          </label>
          <button type="button" style={btnPrimary} disabled={busy !== null || !read || !ready} onClick={() => act("accept", { version: room.version, notice_read: read })}>
            Accept v{room.version}
          </button>
          {!ready ? <span style={{ ...muted, fontSize: 12 }}>Both sides need a proven wallet and at least one Moment must change hands.</span> : null}
        </div>
      )}
    </section>
  )
}

function Execute({
  room,
  side,
  api,
  busy,
  setBusy,
  act,
  setErr,
  setMsg,
  reload,
}: {
  room: RoomView
  side: SideView
  api: string
  busy: string | null
  setBusy: (s: string | null) => void
  act: Act
  setErr: (s: string | null) => void
  setMsg: (s: string | null) => void
  reload: () => Promise<void>
}) {
  const [plan, setPlan] = useState<SwapPlan | MultiPlan | null>(null)
  const [wallet, setWallet] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [cosigned, setCosigned] = useState(false)
  const relay = room.relay

  const simulate = async () => {
    setPlan(null)
    await act("simulate", {}, (r) => {
      setPlan(r.body?.plan as SwapPlan | MultiPlan)
      setMsg("Simulated on mainnet: every Moment lands. Nothing has moved.")
    })
  }

  const reconnect = async () => {
    setErr(null)
    try {
      const w = await loadWallet()
      await w.disconnectTradeWallet()
      setWallet(await w.connectTradeWallet())
    } catch (e) {
      setErr(`Flow Wallet: ${errorText(e)}`)
    }
  }

  const send = async () => {
    if (!plan) return
    setBusy("send")
    setErr(null)
    setHint(null)
    setMsg("Waiting for your wallet, then the other side's…")
    try {
      const w = await loadWallet()
      const io = {
          post: async (cosigner: string, signable: Record<string, unknown>) => {
            const r = await call(api, { method: "POST", body: JSON.stringify({ action: "relay_post", cosigner, signable }) })
            if (!r.ok || typeof r.body?.id !== "string") throw new Error(errorOf(r))
            return r.body.id
          },
          waitForSignature: (id: string) => waitForRelaySignature((rid) => call(`${api}?relay=${encodeURIComponent(rid)}`), id),
          onRelay: () => setMsg("Waiting for the other side to sign on their device (about 9 minutes at most)…"),
      }
      // an all-Top-Shot room signs the original swap; any All Day / Golazos / UFC signs the multi-collection one
      const { txId } = "kind" in plan && plan.kind === "multi" ? await w.sendMultiSwap(plan, io, { onSlow: setHint }) : await w.sendSwap(plan as SwapPlan, io, { onSlow: setHint })
      setMsg("Sealed on chain. Recording it…")
      await act("sealed", { tx_id: txId })
    } catch (e) {
      const w = await loadWallet().catch(() => null)
      if (w && e instanceof w.SealUnconfirmedError) {
        // submitted: it may well have executed. Never "failed", never resend — record it and read the chain.
        // (act() clears the message/error lines, so the note is set AFTER the record lands.)
        await act("sealed", { tx_id: e.txId })
        setErr(`Submitted as ${e.txId}, but its result couldn't be read yet. Don't send again; use "Check the chain again" below.`)
      } else {
        setErr(errorText(e))
        setMsg(null)
        await call(api, { method: "POST", body: JSON.stringify({ action: "signing_ended" }) })
        await reload()
      }
    } finally {
      setHint(null)
      setBusy(null)
    }
  }

  const cosign = async () => {
    if (!relay) return
    setBusy("cosign")
    setErr(null)
    try {
      const w = await loadWallet()
      const { signature, keyId } = await w.coSign(relay.signable, relay.cosigner, w.TRADE_ROOM_CADENCES)
      const r = await call(api, { method: "POST", body: JSON.stringify({ action: "relay_sign", id: relay.id, signature, key_id: keyId }) })
      if (!r.ok) throw new Error(errorOf(r))
      setCosigned(true)
      setMsg("Signed. The other side's page submits the transaction; this page updates when it seals.")
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const d = relay ? describeRoomSignable(relay.signable) : null
  return (
    <section style={card}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, margin: "0 0 6px" }}>Sign</h2>
      {relay && !cosigned ? (
        <div>
          <p style={{ fontSize: 13, margin: "0 0 8px" }}>The other side started the swap and it needs your wallet&apos;s signature. What it does:</p>
          {d?.ok ? (
            <ul style={{ fontSize: 13, fontFamily: MONO, paddingLeft: 18, margin: "0 0 8px" }}>
              <li>
                {d.idsA.length ? d.idsA.join(", ") : "nothing"} from {shortAddr(d.sourceA)} → {shortAddr(d.sourceB)}
              </li>
              <li>
                {d.idsB.length ? d.idsB.join(", ") : "nothing"} from {shortAddr(d.sourceB)} → {shortAddr(d.sourceA)}
              </li>
            </ul>
          ) : (
            <p style={{ color: "var(--rpc-danger-text)", fontSize: 13 }}>{d?.reason}</p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" style={btn} onClick={reconnect} disabled={busy !== null}>
              {wallet ? "Reconnect Flow Wallet" : "Connect Flow Wallet"}
            </button>
            {wallet ? <code style={{ fontSize: 12 }}>{shortAddr(wallet)}</code> : null}
            <button type="button" style={btnPrimary} onClick={cosign} disabled={busy !== null || !wallet || !d?.ok || wallet !== side.signer}>
              Sign
            </button>
            {wallet && wallet !== side.signer ? <span style={{ color: "var(--rpc-danger-text)", fontSize: 12 }}>Connect {shortAddr(side.signer)}, the wallet you proved.</span> : null}
          </div>
        </div>
      ) : (
        <div>
          <p style={{ fontSize: 13, margin: "0 0 8px" }}>
            First simulate the whole swap on mainnet. Then your wallet signs and the other side signs on their device; both signatures must land within about ten minutes, or nothing moves.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" style={btn} onClick={simulate} disabled={busy !== null}>
              {busy === "simulate" ? "Simulating…" : "Simulate on mainnet"}
            </button>
            {plan ? (
              <>
                <button type="button" style={btn} onClick={reconnect} disabled={busy !== null}>
                  {wallet ? "Reconnect Flow Wallet" : "Connect Flow Wallet"}
                </button>
                {wallet ? <code style={{ fontSize: 12 }}>{shortAddr(wallet)}</code> : null}
                <button type="button" style={btnPrimary} onClick={send} disabled={busy !== null || !wallet || wallet !== plan.a.signer || !room.execution.open}>
                  {busy === "send" ? "Waiting…" : "Sign and send"}
                </button>
              </>
            ) : null}
          </div>
          {!room.execution.open && room.execution.message ? <p style={{ ...muted, fontSize: 12, margin: "8px 0 0" }}>{room.execution.message}</p> : null}
          {plan && wallet && wallet !== plan.a.signer ? <p style={{ color: "var(--rpc-danger-text)", fontSize: 12 }}>Connect {shortAddr(plan.a.signer)}, the wallet you proved.</p> : null}
          {hint ? <p style={{ fontSize: 13, color: "var(--rpc-warning-text)" }}>Your wallet hasn&apos;t answered: {hint}</p> : null}
        </div>
      )}
    </section>
  )
}

function Sealed({ room, busy, act }: { room: RoomView; busy: string | null; act: Act }) {
  const landed = Array.isArray(room.landed) ? (room.landed as Array<{ id: string; to: string; held: boolean; collection?: string }>) : null
  return (
    <section style={card}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, margin: "0 0 6px" }}>Sealed on chain</h2>
      {room.tx_id ? (
        <p style={{ fontSize: 13, margin: "0 0 8px", wordBreak: "break-all" }}>
          Transaction{" "}
          <a href={`https://www.flowscan.io/tx/${room.tx_id}`} target="_blank" rel="noreferrer">
            {room.tx_id}
          </a>
        </p>
      ) : null}
      {landed ? (
        <ul style={{ fontSize: 13, fontFamily: MONO, paddingLeft: 18, margin: "0 0 8px" }}>
          {landed.map((m) => (
            <li key={`${m.collection ?? "nba-top-shot"}:${m.id}`} style={{ color: m.held ? undefined : "var(--rpc-danger-text)" }}>
              {m.collection && m.collection !== "nba-top-shot" ? `${SWAP_COLLECTIONS.find((c) => c.slug === m.collection)?.short ?? m.collection} ` : ""}
              {m.id} {m.held ? "is now in" : "is NOT in"} {shortAddr(m.to)}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ ...muted, margin: "0 0 8px" }}>Where each Moment landed hasn&apos;t been read from the chain yet.</p>
      )}
      <button type="button" style={btn} disabled={busy !== null} onClick={() => act("verify", {})}>
        Check the chain again
      </button>
    </section>
  )
}

function agreedLine(i: { collection?: string | null; moment_id: string; player_name: string | null; set_name: string | null; serial_number: number | null }): string {
  return [i.collection ?? null, i.player_name ?? `Moment ${i.moment_id}`, i.set_name, i.serial_number != null ? `#${i.serial_number}` : null].filter(Boolean).join(" · ")
}

/** The Trade Block proposal this room came from: a guide for the picks, never a pick. */
function FromBlockPanel({ room }: { room: RoomView }) {
  const fb = room.from_block
  if (!fb) return null
  const rows: Array<[string, typeof fb.a_gives]> = [
    [room.a.username, fb.a_gives],
    [room.b?.username ?? "The other side", fb.b_gives],
  ]
  return (
    <section style={card}>
      <div style={label}>Agreed on the Trade Block</div>
      {rows.map(([who, items]) => (
        <p key={who} style={{ fontSize: 13, margin: "6px 0 0" }}>
          <strong>{who}</strong> gives: {items.length ? items.map(agreedLine).join("; ") : "nothing"}
        </p>
      ))}
      <p style={{ ...muted, fontSize: 12, margin: "6px 0 0" }}>
        Pick these same Moments below. Only what both of you pick and accept here moves — the room re-checks each one on chain.
        {fb.listing_code ? (
          <>
            {" "}
            <Link href={`/trades/block/${fb.listing_code}`}>The listing</Link>
          </>
        ) : null}
      </p>
    </section>
  )
}
