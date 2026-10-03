"use client"

// app/admin/giveaways/AdminGiveawaysClient.tsx
//
// Build a giveaway from your own giftable (unlocked) Top Shot moments, seal it,
// open it, close it, and work the delivery checklist: gift each claimed Moment
// to the claimer's @username IN THE TOP SHOT APP, then press Verify — RPC reads
// the chain and marks what arrived. RPC never moves a Moment.

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useAdminResource } from "@/lib/admin/use-admin-resource"
import { usd, ptTime, errorText, accountLine, accountName, type AccountLineInput } from "@/lib/giveaways/view-format"
import { checklistRows, type ChecklistRow } from "@/lib/giveaways/checklist"
import type { Candidate, ClaimRow, DropRow, PoolRow } from "@/lib/giveaways/store"
import type { DeliveryPlan } from "@/lib/giveaways/deliver"
import { connectAdminWallet, disconnectAdminWallet, sendDeliveryBatch } from "@/lib/giveaways/admin-wallet"

const DISPLAY = "var(--font-display)"
const MONO = "var(--font-mono)"
const WALLET_KEY = "rpc_giveaway_admin_wallet"

const box: React.CSSProperties = { background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 8, padding: 14 }
const input: React.CSSProperties = {
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--rpc-border)",
  background: "var(--rpc-bg)",
  color: "var(--rpc-text-primary)",
  fontFamily: MONO,
  fontSize: 13,
}
const btn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--rpc-border)",
  background: "var(--rpc-surface-raised)",
  color: "var(--rpc-text-primary)",
  fontFamily: MONO,
  fontSize: 13,
  cursor: "pointer",
}
const th: React.CSSProperties = { textAlign: "left", padding: "4px 6px", fontSize: 11, color: "var(--rpc-text-muted)", textTransform: "uppercase" }
const td: React.CSSProperties = { padding: "4px 6px", fontSize: 13, fontFamily: MONO, borderTop: "1px solid var(--rpc-border-subtle)" }

function readStoredWallet(): string {
  try {
    return localStorage.getItem(WALLET_KEY) ?? ""
  } catch {
    return ""
  }
}

export default function AdminGiveawaysClient() {
  const res = useAdminResource<{ drops: DropRow[] }>("/api/admin/giveaways")
  const { token } = res

  const call = useCallback(
    async (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> => {
      try {
        const r = await fetch(url, {
          ...init,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
          cache: "no-store",
        })
        let body: Record<string, unknown> | null
        try {
          body = (await r.json()) as Record<string, unknown>
        } catch {
          // an unreadable body is a FAILED call even on a 2xx — never "an empty list"
          return { ok: false, status: r.status, body: { error: `HTTP ${r.status}: unreadable response` } }
        }
        return { ok: r.ok, status: r.status, body }
      } catch (e) {
        return { ok: false, status: 0, body: { error: e instanceof Error ? e.message : String(e) } }
      }
    },
    [token],
  )

  if (!token) {
    return (
      <main style={{ maxWidth: 520, margin: "40px auto", padding: 16 }}>
        <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase" }}>Giveaways</h1>
        <p style={{ color: "var(--rpc-text-muted)" }}>Admin token required.</p>
        <input type="password" value={res.tokenInput} onChange={(e) => res.setTokenInput(e.target.value)} style={{ ...input, width: "100%" }} />
        <button type="button" onClick={res.submitToken} style={{ ...btn, marginTop: 8 }}>
          Continue
        </button>
        {res.error ? <p style={{ color: "var(--rpc-danger)" }}>{res.error}</p> : null}
      </main>
    )
  }

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px 80px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <Link href="/admin" style={{ color: "var(--rpc-text-muted)", fontSize: 13 }}>
          ← Admin
        </Link>
        <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: "6px 0" }}>Pack giveaways</h1>
        <p style={{ color: "var(--rpc-text-muted)", fontSize: 13, margin: 0 }}>
          Draft → Seal (on-chain check + shuffle + published fingerprint) → Open → Close. Deliver all sends the claimed Moments from your account with one
          approval in your linked Flow Wallet; Verify reads the chain and marks what arrived.
        </p>
      </div>
      {res.error ? (
        <p style={{ color: "var(--rpc-danger)" }}>
          {res.error}
          {res.stale ? " (showing the last list that loaded)" : ""}
        </p>
      ) : null}
      <CreateDraft call={call} onCreated={res.refresh} />
      <section style={box}>
        <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: "0 0 8px" }}>Drops</h2>
        {res.loading && !res.data ? <p style={{ color: "var(--rpc-text-muted)" }}>Loading…</p> : null}
        {res.data && res.data.drops.length === 0 ? <p style={{ color: "var(--rpc-text-muted)" }}>No drops yet.</p> : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {(res.data?.drops ?? []).map((d) => (
            <DropPanel key={d.id} drop={d} call={call} onChanged={res.refresh} />
          ))}
        </div>
      </section>
    </main>
  )
}

type Call = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }>

type SourcedCandidate = Candidate & { source_wallet?: string }

function CreateDraft({ call, onCreated }: { call: Call; onCreated: () => void }) {
  const [wallet, setWallet] = useState(readStoredWallet)
  // set when the pool comes from a connected Flow Wallet and its linked accounts
  const [connected, setConnected] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<(AccountLineInput & { address: string })[] | null>(null)
  const [candidates, setCandidates] = useState<SourcedCandidate[] | null>(null)
  const [excluded, setExcluded] = useState<{ locked: number; not_held: number } | null>(null)
  const [resolvedFrom, setResolvedFrom] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [form, setForm] = useState({ slug: "", title: "", sponsor_name: "", description: "", pack_count: 5, moments_per_pack: 2 })
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Sign in with Flow Wallet: candidates across the wallet AND every account it has linked (2026-10-03)
  const connectAndLoad = async () => {
    setMsg(null)
    let parent: string
    try {
      parent = await connectAdminWallet()
    } catch (e) {
      setMsg(`Wallet: ${errorText(e)}`)
      return
    }
    const r = await call(`/api/admin/giveaways?accounts_for=${encodeURIComponent(parent)}`)
    if (!r.ok) {
      setCandidates(null)
      setAccounts(null)
      setMsg(String(r.body?.error ?? `HTTP ${r.status}`))
      return
    }
    if (!Array.isArray(r.body?.candidates) || !Array.isArray(r.body?.accounts)) {
      setCandidates(null)
      setAccounts(null)
      setMsg("The account list came back malformed.")
      return
    }
    setConnected(parent)
    setAccounts(r.body.accounts as (AccountLineInput & { address: string })[])
    setCandidates(r.body.candidates as SourcedCandidate[])
    setExcluded(null)
    setResolvedFrom(null)
    setPicked(new Set())
  }

  const loadCandidates = async () => {
    setMsg(null)
    setConnected(null)
    setAccounts(null)
    // an 0x address is lowercased; a Top Shot username goes as typed and the route resolves it
    const raw = wallet.trim()
    const w = /^0x/i.test(raw) ? raw.toLowerCase() : raw
    const r = await call(`/api/admin/giveaways?candidates=${encodeURIComponent(w)}`)
    if (!r.ok) {
      setCandidates(null)
      setMsg(String(r.body?.error ?? `HTTP ${r.status}`))
      return
    }
    if (!Array.isArray(r.body?.candidates)) {
      setCandidates(null)
      setMsg("The candidate list came back malformed.")
      return
    }
    // the draft is created with the RESOLVED address, never the username
    const resolved = typeof r.body.wallet === "string" ? r.body.wallet : w
    setWallet(resolved)
    try {
      localStorage.setItem(WALLET_KEY, resolved)
    } catch {}
    setResolvedFrom(typeof r.body.username === "string" ? r.body.username : null)
    setCandidates(r.body.candidates as Candidate[])
    setExcluded((r.body.excluded as { locked: number; not_held: number }) ?? null)
    setPicked(new Set())
  }

  const sorted = useMemo(() => (candidates ?? []).slice().sort((a, b) => (b.fmv_usd ?? -1) - (a.fmv_usd ?? -1)), [candidates])
  const need = form.pack_count * form.moments_per_pack
  const pickedFmv = sorted.filter((c) => picked.has(c.moment_id)).reduce((s, c) => s + (c.fmv_usd ?? 0), 0)
  const pickedUnpriced = sorted.filter((c) => picked.has(c.moment_id) && c.fmv_usd == null).length

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const create = async () => {
    setBusy(true)
    setMsg(null)
    const ids = [...picked]
    const sourceOf = new Map((candidates ?? []).map((c) => [c.moment_id, c.source_wallet]))
    const body = connected
      ? { ...form, admin_wallet: connected, moment_ids: ids, source_wallets: ids.map((id) => sourceOf.get(id)) }
      : { ...form, admin_wallet: wallet.trim().toLowerCase(), moment_ids: ids }
    const r = await call("/api/admin/giveaways", { method: "POST", body: JSON.stringify(body) })
    setBusy(false)
    if (!r.ok) {
      setMsg(String(r.body?.error ?? `HTTP ${r.status}`))
      return
    }
    setMsg("Draft created.")
    setPicked(new Set())
    onCreated()
  }

  const field = (k: keyof typeof form, label: string, type: "text" | "number" = "text") => (
    <label style={{ fontSize: 12, color: "var(--rpc-text-muted)", display: "flex", flexDirection: "column", gap: 2 }}>
      {label}
      <input
        type={type}
        value={form[k]}
        onChange={(e) => setForm((f) => ({ ...f, [k]: type === "number" ? Number(e.target.value) : e.target.value }))}
        style={input}
      />
    </label>
  )

  return (
    <section style={box}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: "0 0 8px" }}>New draft</h2>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <button type="button" style={btn} onClick={connectAndLoad}>
          Connect Flow Wallet (loads it and every linked account)
        </button>
        {connected ? <span style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>Connected {connected}</span> : null}
      </div>
      {accounts ? (
        <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 12, color: "var(--rpc-text-secondary)" }}>
          {accounts.map((a) => (
            <li key={a.address}>{accountLine(a)}</li>
          ))}
        </ul>
      ) : null}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "var(--rpc-text-muted)", display: "flex", flexDirection: "column", gap: 2 }}>
          Or one account by Top Shot username or wallet
          <input
            value={wallet}
            onChange={(e) => {
              setWallet(e.target.value)
              setResolvedFrom(null)
            }}
            placeholder="username or 0x…"
            style={{ ...input, width: 220 }}
          />
          {resolvedFrom ? <span style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>@{resolvedFrom} → {wallet}</span> : null}
        </label>
        <button type="button" style={btn} onClick={loadCandidates}>
          Load giftable moments (checks the chain)
        </button>
      </div>
      {candidates ? (
        <>
          <p style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>
            {candidates.length} Top Shot moments confirmed giftable on chain just now (locked moments can&apos;t be gifted, so they aren&apos;t listed
            {excluded && excluded.locked + excluded.not_held > 0
              ? `; ${excluded.locked} the cache called unlocked are locked on chain, ${excluded.not_held} no longer held`
              : ""}
            ). Picked {picked.size} of {need} ·{" "}
            {usd(pickedFmv)} FMV{pickedUnpriced ? ` · ${pickedUnpriced} without FMV (sealing will refuse them)` : ""}
          </p>
          <div style={{ maxHeight: 320, overflow: "auto", border: "1px solid var(--rpc-border-subtle)", borderRadius: 6 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th} />
                  <th style={th}>Player</th>
                  <th style={th}>Set</th>
                  <th style={th}>Tier</th>
                  <th style={th}>Serial</th>
                  <th style={th}>Team</th>
                  <th style={th}>FMV</th>
                  {connected ? <th style={th}>From</th> : null}
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => (
                  <tr key={c.moment_id} onClick={() => toggle(c.moment_id)} style={{ cursor: "pointer", background: picked.has(c.moment_id) ? "var(--rpc-red-bg)" : undefined }}>
                    <td style={td}>
                      <input type="checkbox" readOnly checked={picked.has(c.moment_id)} />
                    </td>
                    <td style={td}>{c.player_name ?? "—"}</td>
                    <td style={td}>{c.set_name ?? "—"}</td>
                    <td style={td}>{c.tier ?? "—"}</td>
                    <td style={td}>{c.serial_number ?? "—"}</td>
                    <td style={td}>{c.team_name ?? "—"}</td>
                    <td style={td}>{usd(c.fmv_usd)}</td>
                    {connected ? (
                      <td style={td}>
                        {c.source_wallet ? accountName({ address: c.source_wallet, role: c.source_wallet === connected ? "flow_wallet" : "linked" }) : "—"}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8, marginTop: 10 }}>
            {field("slug", "Slug (URL: /giveaways/<slug>)")}
            {field("title", "Title")}
            {field("sponsor_name", "Sponsor name (shown in the rules)")}
            {field("pack_count", "Packs", "number")}
            {field("moments_per_pack", "Moments per pack", "number")}
          </div>
          <label style={{ fontSize: 12, color: "var(--rpc-text-muted)", display: "flex", flexDirection: "column", gap: 2, marginTop: 8 }}>
            Description (optional)
            <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} style={input} />
          </label>
          <button type="button" style={{ ...btn, marginTop: 8 }} disabled={busy || picked.size !== need} onClick={create}>
            {busy ? "Creating…" : `Create draft (${picked.size}/${need})`}
          </button>
        </>
      ) : null}
      {msg ? <p style={{ fontSize: 13, color: msg === "Draft created." ? "var(--rpc-success)" : "var(--rpc-danger)" }}>{msg}</p> : null}
    </section>
  )
}

function DropPanel({ drop, call, onChanged }: { drop: DropRow; call: Call; onChanged: () => void }) {
  const [detail, setDetail] = useState<{ pool: PoolRow[]; claims: ClaimRow[] } | null>(null)
  const [open, setOpen] = useState(drop.status === "open")
  const [msg, setMsg] = useState<string | null>(null)
  // A failed DETAIL read has its own line: it must never overwrite an action's result
  // (a Verify report replaced by "HTTP 500" would hide which recipients failed).
  const [detailError, setDetailError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await call(`/api/admin/giveaways/${drop.id}`)
    if (!r.ok) {
      setDetailError(String(r.body?.error ?? `HTTP ${r.status}`))
      return
    }
    setDetailError(null)
    setDetail({ pool: (r.body?.pool as PoolRow[]) ?? [], claims: (r.body?.claims as ClaimRow[]) ?? [] })
  }, [call, drop.id])

  useEffect(() => {
    if (!open) return
    let live = true
    void call(`/api/admin/giveaways/${drop.id}`).then((r) => {
      if (!live) return
      if (!r.ok) setDetailError(String(r.body?.error ?? `HTTP ${r.status}`))
      else setDetail({ pool: (r.body?.pool as PoolRow[]) ?? [], claims: (r.body?.claims as ClaimRow[]) ?? [] })
    })
    return () => {
      live = false
    }
  }, [open, call, drop.id])

  const act = async (action: "seal" | "open" | "close" | "verify" | "delete") => {
    if (action === "delete" && !window.confirm("Delete this draft?")) return
    if (action === "close" && !window.confirm("Close claims? The secret and pack list become public.")) return
    setBusy(true)
    setMsg(null)
    const r = await call(`/api/admin/giveaways/${drop.id}`, { method: "POST", body: JSON.stringify({ action }) })
    setBusy(false)
    if (action === "verify" && r.body?.report) {
      const rep = r.body.report as { checked: number; delivered: number; pending: number; missing: number; failed_recipients: string[]; write_error: string | null }
      setMsg(
        `Checked ${rep.checked}: ${rep.delivered} delivered, ${rep.pending} awaiting your gift, ${rep.missing} missing` +
          (rep.failed_recipients.length ? ` · chain read FAILED for ${rep.failed_recipients.join(", ")} (those rows unchanged)` : "") +
          (rep.write_error ? ` · write error: ${rep.write_error}` : ""),
      )
    } else if (!r.ok) {
      setMsg(String(r.body?.error ?? `HTTP ${r.status}`))
    } else {
      setMsg(`${action}: done`)
    }
    onChanged()
    if (open) void load()
  }

  const rows: ChecklistRow[] = detail ? checklistRows(detail.pool, detail.claims) : []

  return (
    <div style={{ border: "1px solid var(--rpc-border)", borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontFamily: DISPLAY, textTransform: "uppercase" }}>{drop.title}</strong>
        <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--rpc-text-muted)" }}>
          {drop.status} · {drop.pack_count}×{drop.moments_per_pack} · created {ptTime(drop.created_at)}
        </span>
        {drop.status !== "draft" ? (
          <Link href={`/giveaways/${drop.slug}`} style={{ fontSize: 12, color: "var(--rpc-red)" }}>
            /giveaways/{drop.slug}
          </Link>
        ) : null}
        <span style={{ flex: 1 }} />
        {drop.status === "draft" ? (
          <>
            <button type="button" style={btn} disabled={busy} onClick={() => act("seal")}>
              Seal
            </button>
            <button type="button" style={btn} disabled={busy} onClick={() => act("delete")}>
              Delete
            </button>
          </>
        ) : null}
        {drop.status === "sealed" ? (
          <button type="button" style={btn} disabled={busy} onClick={() => act("open")}>
            Open claims
          </button>
        ) : null}
        {drop.status === "open" ? (
          <button type="button" style={btn} disabled={busy} onClick={() => act("close")}>
            Close claims
          </button>
        ) : null}
        {drop.status === "open" || drop.status === "closed" ? (
          <button type="button" style={btn} disabled={busy} onClick={() => act("verify")}>
            {busy ? "Working…" : "Verify deliveries"}
          </button>
        ) : null}
        <button type="button" style={btn} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Details"}
        </button>
      </div>
      {msg ? <p style={{ fontSize: 13, fontFamily: MONO, color: "var(--rpc-text-secondary)", margin: "8px 0 0" }}>{msg}</p> : null}
      {open && detailError ? (
        <p style={{ fontSize: 13, fontFamily: MONO, color: "var(--rpc-danger)", margin: "8px 0 0" }}>Couldn&apos;t load the checklist: {detailError}</p>
      ) : null}
      {drop.status === "open" || drop.status === "closed" ? <DeliverAll drop={drop} call={call} onDone={() => { onChanged(); if (open) void load() }} /> : null}
      {open && detail ? (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10 }}>
          <thead>
            <tr>
              <th style={th}>Pack</th>
              <th style={th}>Gift to</th>
              <th style={th}>Moment</th>
              <th style={th}>Player</th>
              <th style={th}>Serial</th>
              <th style={th}>FMV</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.moment_id}>
                <td style={td}>{r.pack_no ?? "—"}</td>
                <td style={td}>{r.username ? `@${r.username}` : "—"}</td>
                <td style={td}>{r.moment_id}</td>
                <td style={td}>{r.player_name ?? "—"}</td>
                <td style={td}>{r.serial_number ?? "—"}</td>
                <td style={td}>{usd(r.fmv_usd)}</td>
                <td style={{ ...td, color: r.state === "delivered" ? "var(--rpc-success)" : r.state === "missing" ? "var(--rpc-danger)" : undefined }}>
                  {r.stateLabel}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}

// One signature per batch (≤ 50 moments): the connected Flow Wallet must be a
// Hybrid Custody PARENT of the drop's admin wallet. Every batch was simulated on
// mainnet by the plan; after the last one seals, Verify reads the chain.
function DeliverAll({ drop, call, onDone }: { drop: DropRow; call: Call; onDone: () => void }) {
  const [wallet, setWallet] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const note = (line: string) => setLog((l) => [...l, line])

  const connect = async () => {
    setLog([])
    try {
      setWallet(await connectAdminWallet())
    } catch (e) {
      note(`Wallet: ${errorText(e)}`)
    }
  }

  const disconnect = async () => {
    await disconnectAdminWallet().catch(() => undefined)
    setWallet(null)
  }

  const deliver = async () => {
    if (!wallet) return
    setBusy(true)
    setLog([])
    try {
      const r = await call(`/api/admin/giveaways/${drop.id}`, { method: "POST", body: JSON.stringify({ action: "deliver_plan", parent: wallet }) })
      if (!r.ok) {
        note(String(r.body?.error ?? `HTTP ${r.status}`))
        return
      }
      const plan = r.body?.plan as DeliveryPlan | undefined
      if (!plan || !Array.isArray(plan.batches)) {
        note("The delivery plan came back malformed.")
        return
      }
      const n = plan.batches.reduce((s, b) => s + b.momentIDs.length, 0)
      for (const sk of plan.skipped) note(`Skipped ${sk.moment_id}: ${sk.reason === "locked" ? "locked on chain" : "no longer in your account"}`)
      const from = [...new Set(plan.batches.map((b) => b.source))].join(", ")
      if (!window.confirm(`Send ${n} moment(s) from ${from} in ${plan.batches.length} transaction(s)? Your Flow Wallet will ask you to approve each one.`)) {
        note("Cancelled; nothing was sent.")
        return
      }
      for (const [i, b] of plan.batches.entries()) {
        note(`Batch ${i + 1}/${plan.batches.length}: waiting for your wallet…`)
        try {
          const sent = await sendDeliveryBatch(b)
          note(`Batch ${i + 1}: sealed · ${b.momentIDs.length} moment(s) · tx ${sent.txId}`)
        } catch (e) {
          note(`Batch ${i + 1} NOT sent: ${errorText(e)}`)
          break
        }
      }
      const v = await call(`/api/admin/giveaways/${drop.id}`, { method: "POST", body: JSON.stringify({ action: "verify" }) })
      const rep = v.body?.report as { delivered: number; pending: number; missing: number; failed_recipients: string[] } | undefined
      note(
        rep
          ? `Verified on chain: ${rep.delivered} delivered, ${rep.pending} still with you, ${rep.missing} missing` +
              (rep.failed_recipients.length ? ` · chain read FAILED for ${rep.failed_recipients.join(", ")}` : "")
          : `Verify: ${String(v.body?.error ?? `HTTP ${v.status}`)}`,
      )
    } finally {
      setBusy(false)
      onDone()
    }
  }

  return (
    <div style={{ marginTop: 10, padding: 10, border: "1px dashed var(--rpc-border)", borderRadius: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontFamily: MONO, fontSize: 12, textTransform: "uppercase" }}>Deliver all</strong>
        {wallet ? (
          <>
            <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--rpc-text-muted)" }}>Flow Wallet {wallet}</span>
            <button type="button" style={btn} disabled={busy} onClick={deliver}>
              {busy ? "Delivering…" : "Deliver claimed moments"}
            </button>
            <button type="button" style={btn} disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <button type="button" style={btn} onClick={connect}>
            Connect Flow Wallet
          </button>
        )}
      </div>
      {log.length ? (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontFamily: MONO, fontSize: 12, color: "var(--rpc-text-secondary)" }}>
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
