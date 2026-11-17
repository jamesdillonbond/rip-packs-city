"use client"

// app/trades/compare/CompareClient.tsx
//
// "What could two collectors trade?" (2026-11-16). Two Top Shot usernames in; each side's
// duplicates in editions the other doesn't own, checked on chain (held, unlocked, not listed),
// priced with RPC FMV; a Quick Trade; a builder that hands off to a trade room.
//
// States, never collapsed: idle · loading · could not load (Retry, the route's own words) · a
// named refusal (unknown username, same collector, rate limit) · the result. An empty side reads
// "nothing to trade" only when the read succeeded; a short index says so and that it is indexing.

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import type { CompareEdition, QuickTrade } from "@/lib/trade-compare/compare"
import { MAX_ITEMS_PER_SIDE } from "@/lib/trade-room/valuation"
import { fmvBasis } from "@/lib/fmv-basis"
import { seriesDisplay } from "@/lib/series-label"
import { call, card, btn, btnPrimary, DISPLAY, errorOf, fmtUsd, label, MONO, muted } from "../trade-ui"

type Coverage = { indexed: number; on_chain: number | null; complete: boolean | null }
type Side = {
  username: string
  editions: CompareEdition[]
  editions_total: number
  candidates_total: number
  capped: boolean
  blocked: { locked: number; listed: number; gone: number }
  coverage: Coverage
  indexing: boolean
}
type Result = { collection?: string; a: Side; b: Side; quick_trade: QuickTrade | null; checked_at: string }
type Load =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "refused"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ok"; data: Result }

type Pick = { side: "a" | "b"; moment_id: string; serial: number | null; edition_key: string; title: string; fmv: number | null }

const ASKS = fmvBasis("ASK_ONLY")!

// Compare covers these three (2026-11-16 afternoon). One Dapper wallet holds all of them, so the
// same Top Shot usernames name the wallets for each.
const COLLECTIONS = [
  { slug: "nba-top-shot", label: "NBA Top Shot" },
  { slug: "nfl-all-day", label: "NFL All Day" },
  { slug: "laliga-golazos", label: "LaLiga Golazos" },
] as const
type Slug = (typeof COLLECTIONS)[number]["slug"]
const isSlug = (v: string | null): v is Slug => COLLECTIONS.some((c) => c.slug === v)

function seriesOf(e: CompareEdition, slug: Slug): string {
  return e.series_number == null ? "Unknown series" : seriesDisplay(e.series_number, slug)
}

function sumPicks(p: readonly Pick[]): { total: number; unpriced: number } {
  let total = 0
  let unpriced = 0
  for (const x of p) {
    if (x.fmv == null) unpriced++
    else total += x.fmv
  }
  return { total: Math.round(total * 100) / 100, unpriced }
}

export default function CompareClient() {
  const router = useRouter()
  const params = useSearchParams()
  const [u1, setU1] = useState(params.get("u1") ?? "")
  const initialC = params.get("c")
  const [coll, setColl] = useState<Slug>(isSlug(initialC) ? initialC : "nba-top-shot")
  const [u2, setU2] = useState(params.get("u2") ?? "")
  const [load, setLoad] = useState<Load>({ kind: "idle" })
  const [series, setSeries] = useState("")
  const [rookieOnly, setRookieOnly] = useState(false)
  const [league, setLeague] = useState<"" | "NBA" | "WNBA">("")
  const [picks, setPicks] = useState<Pick[]>([])
  const [room, setRoom] = useState<{ kind: "idle" } | { kind: "starting" } | { kind: "signin" } | { kind: "error"; message: string } | { kind: "unplanned"; code: string }>({ kind: "idle" })
  const [copied, setCopied] = useState(false)

  const run = useCallback(async (a: string, b: string, c: Slug) => {
    setLoad({ kind: "loading" })
    const r = await call(`/api/public/trades/compare?u1=${encodeURIComponent(a)}&u2=${encodeURIComponent(b)}&c=${c}`)
    if (r.ok && r.body && typeof r.body === "object" && "a" in r.body && "b" in r.body) {
      setLoad({ kind: "ok", data: r.body as unknown as Result })
      return
    }
    if (r.status === 400 || r.status === 404 || r.status === 429) return setLoad({ kind: "refused", message: errorOf(r) })
    setLoad({ kind: "error", message: errorOf(r) })
  }, [])

  // a shared link (?u1&u2) runs on arrival; ?give / ?get restore a planned trade once loaded
  useEffect(() => {
    const a = params.get("u1")
    const b = params.get("u2")
    if (a && b) void run(a, b, coll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Signed in with a Top Shot username on file → it pre-fills "You". A convenience only: signed
  // out, no username or a failed read all leave the field as it was (an empty field claims nothing).
  useEffect(() => {
    if (params.get("u1")) return
    let live = true
    void call("/api/profile/me").then((r) => {
      const name = (r.body?.user as { topshot_username?: unknown } | null | undefined)?.topshot_username
      if (live && r.ok && typeof name === "string" && name.trim()) setU1((cur) => (cur ? cur : name.trim()))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (load.kind !== "ok") return
    const give = (params.get("give") ?? "").split(",").filter(Boolean)
    const get = (params.get("get") ?? "").split(",").filter(Boolean)
    if (!give.length && !get.length) return
    const restore: Pick[] = []
    const scan = (side: "a" | "b", eds: CompareEdition[], ids: string[]) => {
      for (const e of eds) for (const c of e.tradeable) if (ids.includes(c.moment_id)) restore.push(toPick(side, e, c))
    }
    scan("a", load.data.a.editions, give)
    scan("b", load.data.b.editions, get)
    setPicks(restore)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.kind])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const a = u1.trim().replace(/^@/, "")
    const b = u2.trim().replace(/^@/, "")
    if (!a || !b) return setLoad({ kind: "refused", message: "Enter two Top Shot usernames." })
    setPicks([])
    setSeries("")
    router.replace(`/trades/compare?u1=${encodeURIComponent(a)}&u2=${encodeURIComponent(b)}${coll === "nba-top-shot" ? "" : `&c=${coll}`}`, { scroll: false })
    void run(a, b, coll)
  }

  const data = load.kind === "ok" ? load.data : null

  // switching collection re-runs a comparison already on screen (same two collectors)
  const changeCollection = (v: string) => {
    if (!isSlug(v)) return
    setColl(v)
    setSeries("")
    setPicks([])
    if (load.kind === "ok" || load.kind === "error") {
      const a = (data?.a.username ?? u1).trim()
      const b = (data?.b.username ?? u2).trim()
      if (a && b) {
        router.replace(`/trades/compare?u1=${encodeURIComponent(a)}&u2=${encodeURIComponent(b)}${v === "nba-top-shot" ? "" : `&c=${v}`}`, { scroll: false })
        void run(a, b, v)
      }
    }
  }
  const seriesOptions = useMemo(() => {
    if (!data) return []
    const s = new Map<string, number>()
    for (const e of [...data.a.editions, ...data.b.editions]) s.set(seriesOf(e, coll), e.series_number ?? 99)
    return [...s.entries()].sort((x, y) => x[1] - y[1]).map(([k]) => k)
  }, [data, coll])

  const visible = useCallback(
    (eds: CompareEdition[]) =>
      eds.filter(
        (e) =>
          (!series || seriesOf(e, coll) === series) &&
          (coll !== "nba-top-shot" || !rookieOnly || /rookie debut/i.test(e.set_name ?? "")) &&
          (coll !== "nba-top-shot" || !league || (e.league ?? "NBA").toUpperCase() === league),
      ),
    [series, rookieOnly, league, coll],
  )

  const toggle = (side: "a" | "b", e: CompareEdition, c: { moment_id: string; serial_number: number | null }) => {
    setPicks((p) => {
      if (p.some((x) => x.moment_id === c.moment_id && x.side === side)) return p.filter((x) => !(x.moment_id === c.moment_id && x.side === side))
      if (p.filter((x) => x.side === side).length >= MAX_ITEMS_PER_SIDE) return p
      return [...p, toPick(side, e, c)]
    })
  }

  const loadQuick = (q: QuickTrade) => {
    if (!data) return
    const toPicks = (side: "a" | "b", eds: CompareEdition[], items: QuickTrade["a"]): Pick[] | null => {
      const out: Pick[] = []
      for (const it of items) {
        const e = eds.find((x) => x.edition_key === it.edition_key)
        if (!e) return null
        out.push(toPick(side, e, { moment_id: it.moment_id, serial_number: it.serial_number }))
      }
      return out
    }
    const pa = toPicks("a", data.a.editions, q.a)
    const pb = toPicks("b", data.b.editions, q.b)
    if (!pa || !pb) return
    setPicks([...pa, ...pb])
  }

  const planUrl = useMemo(() => {
    if (!data) return null
    const give = picks.filter((p) => p.side === "a").map((p) => p.moment_id).join(",")
    const get = picks.filter((p) => p.side === "b").map((p) => p.moment_id).join(",")
    const q = new URLSearchParams({ u1: data.a.username, u2: data.b.username })
    if (coll !== "nba-top-shot") q.set("c", coll)
    if (give) q.set("give", give)
    if (get) q.set("get", get)
    return `/trades/compare?${q.toString()}`
  }, [data, picks, coll])

  const copyPlan = async () => {
    if (!planUrl) return
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${planUrl}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const startRoom = async () => {
    setRoom({ kind: "starting" })
    if (!data) return
    const plan = {
      collection: coll,
      partner_username: data.b.username,
      give: picks.filter((p) => p.side === "a").map((p) => p.moment_id),
      get: picks.filter((p) => p.side === "b").map((p) => p.moment_id),
    }
    const r = await call("/api/trade-room", { method: "POST", body: JSON.stringify({ plan }) })
    if (r.status === 401) return setRoom({ kind: "signin" })
    const code = (r.body?.room as { code?: unknown } | undefined)?.code
    if (!r.ok || typeof code !== "string") return setRoom({ kind: "error", message: r.ok ? "The trade was created but its link was missing. Open your trades to find it." : errorOf(r) })
    // the room exists but the plan didn't attach: say so instead of arriving at a room without it
    if (r.body?.plan_saved === false) return setRoom({ kind: "unplanned", code })
    router.push(`/trades/${code}`)
  }

  const give = picks.filter((p) => p.side === "a")
  const get = picks.filter((p) => p.side === "b")
  const sg = sumPicks(give)
  const sr = sumPicks(get)

  return (
    <main id="content" style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px 120px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: "0 0 4px", fontSize: 28 }}>Compare collections</h1>
        <p style={{ ...muted, margin: 0, fontSize: 14 }}>
          Enter two NBA Top Shot usernames and pick a collection — Top Shot, NFL All Day or LaLiga Golazos (one Dapper account holds all three). You&apos;ll see the duplicates each collector holds in editions the other doesn&apos;t own — checked on chain just now, so locked
          Moments and Moments listed for sale are left out — priced with RPC&apos;s FMV, never a single asking price. One copy of every edition always stays with its owner.
        </p>
      </div>

      <form onSubmit={submit} style={{ ...card, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 180px" }}>
          <span style={label}>You</span>
          <input value={u1} onChange={(e) => setU1(e.target.value)} placeholder="Top Shot username" autoComplete="off" spellCheck={false} aria-label="Your Top Shot username" style={inputStyle} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 180px" }}>
          <span style={label}>Trade partner</span>
          <input value={u2} onChange={(e) => setU2(e.target.value)} placeholder="Top Shot username" autoComplete="off" spellCheck={false} aria-label="Trade partner's Top Shot username" style={inputStyle} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: "0 1 170px" }}>
          <span style={label}>Collection</span>
          <select value={coll} onChange={(e) => changeCollection(e.target.value)} aria-label="Collection" style={inputStyle}>
            {COLLECTIONS.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" style={btnPrimary} disabled={load.kind === "loading"}>
          {load.kind === "loading" ? "Checking…" : "Compare"}
        </button>
      </form>

      {load.kind === "loading" && (
        <p style={muted} role="status">
          Reading both collections and checking each candidate on chain. A large collection can take up to half a minute.
        </p>
      )}
      {load.kind === "refused" && (
        <p role="alert" style={{ ...card, color: "var(--rpc-red-text)" }}>
          {load.message}
        </p>
      )}
      {load.kind === "error" && (
        <div role="alert" style={{ ...card, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span>{load.message}</span>
          <button type="button" style={btn} onClick={() => void run(u1.trim(), u2.trim(), coll)}>
            Retry
          </button>
        </div>
      )}

      {data && (
        <>
          <CoverageNotes side={data.a} collection={coll} />
          <CoverageNotes side={data.b} collection={coll} />

          <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }} aria-label="Quick Trade">
            <div style={label}>Quick Trade</div>
            {data.quick_trade ? (
              <>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <QuickSide who={data.a.username} q={data.quick_trade.a} />
                  <span style={{ fontFamily: MONO }} aria-hidden>
                    ⇄
                  </span>
                  <QuickSide who={data.b.username} q={data.quick_trade.b} />
                </div>
                <div style={muted}>
                  Close in value on RPC&apos;s FMV ({data.quick_trade.difference_usd === 0 ? "the same price" : `${fmtUsd(Math.abs(data.quick_trade.difference_usd))} apart`}). The most
                  valuable one-for-one or two-for-one swap whose sides are within $1 or 10 % of each other.
                </div>
                <div>
                  <button type="button" style={btn} onClick={() => loadQuick(data.quick_trade as QuickTrade)}>
                    Load into the trade builder
                  </button>
                </div>
              </>
            ) : (
              <div style={muted}>No one-for-one or two-for-one swap is close enough in value with confident prices on both sides. Build a trade from the lists below.</div>
            )}
          </section>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <select value={series} onChange={(e) => setSeries(e.target.value)} aria-label="Series" style={inputStyle}>
              <option value="">All series</option>
              {seriesOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {coll === "nba-top-shot" && (
              <>
            <select value={league} onChange={(e) => setLeague(e.target.value as "" | "NBA" | "WNBA")} aria-label="League" style={inputStyle}>
              <option value="">NBA + WNBA</option>
              <option value="NBA">NBA</option>
              <option value="WNBA">WNBA</option>
            </select>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={rookieOnly} onChange={(e) => setRookieOnly(e.target.checked)} /> Rookie Debut only
            </label>
              </>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))", gap: 16 }}>
            <SideList title={`@${data.a.username} could trade`} other={data.b.username} side={data.a} eds={visible(data.a.editions)} picks={picks} onToggle={(e, c) => toggle("a", e, c)} sideKey="a" coll={coll} />
            <SideList title={`@${data.b.username} could trade`} other={data.a.username} side={data.b} eds={visible(data.b.editions)} picks={picks} onToggle={(e, c) => toggle("b", e, c)} sideKey="b" coll={coll} />
          </div>

          <section
            aria-label="Trade builder"
            style={{ ...card, position: "sticky", bottom: 12, display: "flex", flexDirection: "column", gap: 8, boxShadow: "0 4px 18px rgba(0,0,0,0.35)" }}
          >
            <div style={label}>Trade builder</div>
            {picks.length === 0 ? (
              <div style={muted}>Tap a serial number to add that exact copy (up to {MAX_ITEMS_PER_SIDE} a side).</div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, fontSize: 13 }}>
                  <PickList who={data.a.username} picks={give} sum={sg} onRemove={(p) => setPicks((x) => x.filter((y) => y !== p))} />
                  <PickList who={data.b.username} picks={get} sum={sr} onRemove={(p) => setPicks((x) => x.filter((y) => y !== p))} />
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button type="button" style={btn} onClick={() => void copyPlan()}>
                    {copied ? "Link copied" : "Copy link to this trade"}
                  </button>
                  <button type="button" style={btnPrimary} onClick={() => void startRoom()} disabled={room.kind === "starting"}>
                    {room.kind === "starting" ? "Starting…" : "Start a trade room"}
                  </button>
                  <button type="button" style={btn} onClick={() => setPicks([])}>
                    Clear
                  </button>
                </div>
                <div style={muted}>
                  The room is where the trade happens: it carries this plan, so each of you adds your planned Moments from your own account with one tap. Send @{data.b.username}
                  the room&apos;s link; both wallets sign one transaction — every Moment moves or none does.
                </div>
                {room.kind === "signin" && (
                  <div role="alert" style={{ fontSize: 13 }}>
                    <Link href={`/login?next=${encodeURIComponent(planUrl ?? "/trades/compare")}`}>Sign in</Link> to start a trade room. Your trade stays in this page&apos;s link.
                  </div>
                )}
                {room.kind === "unplanned" && (
                  <div role="alert" style={{ fontSize: 13 }}>
                    The trade room is ready, but this plan couldn&apos;t be attached to it — add the Moments there by hand (this page&apos;s link keeps the plan).{" "}
                    <Link href={`/trades/${room.code}`}>Open the trade room</Link>
                  </div>
                )}
                {room.kind === "error" && (
                  <div role="alert" style={{ fontSize: 13, color: "var(--rpc-red-text)" }}>
                    {room.message}
                  </div>
                )}
              </>
            )}
          </section>

          <p style={{ ...muted, fontSize: 12 }}>
            {/* hydration-safe: data exists only after a client fetch, never at SSR — the viewer's own clock is the right zone */}
            Checked on chain at {new Date(data.checked_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}. Values are RPC&apos;s fair market
            value for the edition and don&apos;t price serial-number premiums. Confirm on the marketplace before you trade.
          </p>
        </>
      )}
    </main>
  )
}

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--rpc-border)",
  background: "var(--rpc-surface-raised)",
  color: "var(--rpc-text-primary)",
  fontSize: 14,
}

function toPick(side: "a" | "b", e: CompareEdition, c: { moment_id: string; serial_number: number | null }): Pick {
  return { side, moment_id: c.moment_id, serial: c.serial_number, edition_key: e.edition_key, title: `${e.player_name ?? "Moment"} · ${e.set_name ?? ""}`.trim(), fmv: e.fmv_usd }
}

function Fmv({ e }: { e: CompareEdition }) {
  if (e.fmv_usd == null) return <span style={muted}>not priced</span>
  return (
    <span style={{ fontFamily: MONO }}>
      {fmtUsd(e.fmv_usd)}
      {e.from_asks && (
        <span style={{ ...muted, fontSize: 11, marginLeft: 6 }} title={ASKS.title}>
          {ASKS.label}
        </span>
      )}
    </span>
  )
}

function CoverageNotes({ side, collection }: { side: Side; collection: Slug }) {
  const notes: string[] = []
  const c = side.coverage
  if (c.indexed === 0 && c.on_chain === 0) notes.push(`@${side.username} holds no Top Shot Moments.`)
  else if (c.complete === false) {
    notes.push(
      `RPC has read ${c.indexed.toLocaleString("en-US")} of @${side.username}'s ${c.on_chain?.toLocaleString("en-US")} Moments, so this list may be missing some${side.indexing ? " — reading the rest now; compare again in a few minutes" : ""}.`,
    )
  } else if (c.complete === null) notes.push(`Couldn't confirm RPC has read all of @${side.username}'s Moments; the list may be missing some.`)
  const b = side.blocked
  const left: string[] = []
  if (b.locked) left.push(`${b.locked} locked`)
  if (b.listed) left.push(`${b.listed} listed for sale`)
  if (b.gone) left.push(collection === "nfl-all-day" ? `${b.gone} not in the wallet on chain (All Day's locked Moments are held by Dapper)` : `${b.gone} no longer in the account`)
  if (left.length) notes.push(`Left out for @${side.username}: ${left.join(", ")}.`)
  if (side.capped) notes.push(`@${side.username} has ${side.candidates_total.toLocaleString("en-US")} possible Moments; the most valuable were checked.`)
  if (!notes.length) return null
  return (
    <div style={{ ...muted, fontSize: 12 }}>
      {notes.map((n) => (
        <div key={n}>{n}</div>
      ))}
    </div>
  )
}

function QuickSide({ who, q }: { who: string; q: QuickTrade["a"] }) {
  const total = Math.round(q.reduce((t, i) => t + i.fmv_usd, 0) * 100) / 100
  return (
    <div style={{ flex: "1 1 220px", border: "1px solid var(--rpc-border)", borderRadius: 6, padding: 10 }}>
      <div style={{ ...label, marginBottom: 4 }}>@{who} gives</div>
      {q.map((i) => (
        <div key={i.moment_id} style={{ marginBottom: 4 }}>
          <div style={{ fontWeight: 700 }}>{i.player_name ?? "Moment"}</div>
          <div style={muted}>
            {i.set_name}
            {i.serial_number != null ? ` · #${i.serial_number}` : ""} · <span style={{ fontFamily: MONO }}>{fmtUsd(i.fmv_usd)}</span>
          </div>
        </div>
      ))}
      {q.length > 1 ? <div style={{ fontFamily: MONO, marginTop: 4 }}>Total {fmtUsd(total)}</div> : null}
    </div>
  )
}

function SideList(props: {
  title: string
  other: string
  side: Side
  eds: CompareEdition[]
  picks: Pick[]
  sideKey: "a" | "b"
  coll: Slug
  onToggle: (e: CompareEdition, c: { moment_id: string; serial_number: number | null }) => void
}) {
  const { title, other, side, eds, picks, sideKey, coll, onToggle } = props
  return (
    <section aria-label={title} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 18, margin: 0 }}>{title}</h2>
      <div style={muted}>
        {side.editions_total === 0
          ? `No duplicates @${other} doesn't own that can be traded right now.`
          : `${side.editions_total} edition${side.editions_total === 1 ? "" : "s"} @${other} doesn't own${eds.length !== side.editions_total ? ` · ${eds.length} shown` : ""}`}
      </div>
      {eds.map((e) => (
        <article key={e.edition_key} style={{ ...card, padding: 10, display: "flex", gap: 10 }}>
          {e.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={e.image_url} alt="" width={56} height={56} loading="lazy" style={{ borderRadius: 4, objectFit: "cover", flex: "none" }} />
          ) : null}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <strong>{e.player_name ?? "Moment"}</strong>
              <Fmv e={e} />
            </div>
            <div style={{ ...muted, fontSize: 12 }}>
              {[seriesOf(e, coll), e.set_name, e.tier ? e.tier.charAt(0) + e.tier.slice(1).toLowerCase() : null].filter(Boolean).join(" · ")}
            </div>
            <div style={{ ...muted, fontSize: 12 }}>
              Owns {e.owned} · {e.tradeable.length} can move
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              {e.tradeable.map((c) => {
                const on = picks.some((p) => p.side === sideKey && p.moment_id === c.moment_id)
                return (
                  <button
                    key={c.moment_id}
                    type="button"
                    aria-pressed={on}
                    aria-label={`${on ? "Remove" : "Add"} serial ${c.serial_number ?? "unknown"} ${on ? "from" : "to"} the trade`}
                    onClick={() => onToggle(e, c)}
                    style={{ ...btn, padding: "3px 8px", fontSize: 12, ...(on ? { background: "var(--rpc-red-fill)", borderColor: "var(--rpc-red-fill)", color: "#fff" } : {}) }}
                  >
                    #{c.serial_number ?? "?"}
                  </button>
                )
              })}
            </div>
          </div>
        </article>
      ))}
    </section>
  )
}

function PickList({ who, picks, sum, onRemove }: { who: string; picks: Pick[]; sum: { total: number; unpriced: number }; onRemove: (p: Pick) => void }) {
  return (
    <div>
      <div style={{ ...label, marginBottom: 4 }}>@{who} gives</div>
      {picks.length === 0 ? (
        <div style={muted}>Nothing yet</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 16 }}>
          {picks.map((p) => (
            <li key={p.moment_id}>
              {p.title}
              {p.serial != null ? ` #${p.serial}` : ""} · {p.fmv == null ? "not priced" : fmtUsd(p.fmv)}{" "}
              <button type="button" onClick={() => onRemove(p)} style={{ ...btn, padding: "0 6px", fontSize: 11 }} aria-label={`Remove ${p.title} from the trade`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {picks.length > 0 && (
        <div style={{ fontFamily: MONO, marginTop: 4 }}>
          {sum.total > 0 || sum.unpriced === 0 ? fmtUsd(sum.total) : "—"}
          {sum.unpriced > 0 ? <span style={muted}> + {sum.unpriced} not priced</span> : null}
        </div>
      )}
    </div>
  )
}
