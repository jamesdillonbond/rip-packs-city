"use client"

// app/admin/swap-test/SwapTestClient.tsx
//
// The admin-only two-signer swap test. Two roles, usually on two devices:
//   * INITIATOR (side A's wallet): plan + simulate, then sign and submit. When the
//     transaction needs side B's signature, a co-signer link appears.
//   * CO-SIGNER (side B's wallet): open that link, check what is being signed, sign.
// Both signatures must land within ~10 minutes or the network rejects the transaction
// and nothing moves. RPC never holds a key or a moment.

import { useCallback, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useAdminResource } from "@/lib/admin/use-admin-resource"
import { errorText } from "@/lib/giveaways/view-format"
import type { SwapPlan } from "@/lib/swap-test/plan"
import type { RelayRow } from "@/lib/swap-test/relay"
import { describeSignable, parseIds, waitForRelaySignature } from "@/lib/swap-test/view"
import { coSign, connectFlowWallet, disconnectFlowWallet, sendSwap } from "@/lib/swap-test/swap-wallet"

const DISPLAY = "var(--font-display)"
const MONO = "var(--font-mono)"
const box: React.CSSProperties = { background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 8, padding: 14 }
const input: React.CSSProperties = {
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--rpc-border)",
  background: "var(--rpc-bg)",
  color: "var(--rpc-text-primary)",
  fontFamily: MONO,
  fontSize: 13,
  width: "100%",
  boxSizing: "border-box",
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
const label: React.CSSProperties = { fontSize: 11, color: "var(--rpc-text-muted)", textTransform: "uppercase" }

// Trevor's first run (2026-10-03): his Flow Wallet 0x3d0b… gives one $0.25 moment from
// his linked Dapper account. Side B is a SECOND Flow Wallet account he creates (with
// the Top Shot collection enabled): his other linked parent 0xd96d… looks like an old
// Blocto account (main key split 999 + 1) that he doesn't believe can sign (2026-10-04).
const FIRST_RUN = {
  aSigner: "0x3d0b274c80263484",
  aSource: "0xbd94cade097e50ac",
  aIds: "27289790",
  bSigner: "",
  bSource: "",
  bIds: "",
}

export default function SwapTestClient() {
  const relayId = useSearchParams().get("relay")
  const res = useAdminResource<{ relay: RelayRow }>(relayId ? `/api/admin/swap-test?relay=${encodeURIComponent(relayId)}` : null)
  const { token } = res

  const call = useCallback(
    async (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }> => {
      try {
        const r = await fetch(url, {
          ...init,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          cache: "no-store",
        })
        let body: Record<string, unknown> | null
        try {
          body = (await r.json()) as Record<string, unknown>
        } catch {
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
        <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase" }}>Swap test</h1>
        <p style={{ color: "var(--rpc-text-muted)" }}>Admin token required.</p>
        <input type="password" value={res.tokenInput} onChange={(e) => res.setTokenInput(e.target.value)} style={input} />
        <button type="button" onClick={res.submitToken} style={{ ...btn, marginTop: 8 }}>
          Continue
        </button>
        {res.error ? <p style={{ color: "var(--rpc-danger)" }}>{res.error}</p> : null}
      </main>
    )
  }

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "24px 16px 80px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <Link href="/admin" style={{ color: "var(--rpc-text-muted)", fontSize: 13 }}>
          ← Admin
        </Link>
        <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: "8px 0 4px" }}>Two-signer swap test</h1>
        <p style={{ color: "var(--rpc-text-muted)", margin: 0, fontSize: 14 }}>
          One transaction, two Flow Wallets. Side A&apos;s moments go to side B&apos;s account and B&apos;s to A&apos;s, or nothing moves.
          RPC never holds a key or a moment. Admin-only test on your own wallets.
        </p>
      </div>
      {relayId ? <CoSigner relayId={relayId} relay={res.data?.relay ?? null} loadError={res.error} loading={res.loading} call={call} /> : <Initiator call={call} />}
    </main>
  )
}

type Call = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> | null }>

function Initiator({ call }: { call: Call }) {
  const [f, setF] = useState(FIRST_RUN)
  const [plan, setPlan] = useState<SwapPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [wallet, setWallet] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [txId, setTxId] = useState<string | null>(null)

  const set = (k: keyof typeof FIRST_RUN) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setF({ ...f, [k]: e.target.value })
    setPlan(null)
  }

  const simulate = async () => {
    setBusy(true)
    setErr(null)
    setMsg(null)
    setPlan(null)
    const r = await call("/api/admin/swap-test", {
      method: "POST",
      body: JSON.stringify({
        action: "plan",
        a: { signer: f.aSigner, source: f.aSource, ids: parseIds(f.aIds) },
        b: { signer: f.bSigner, source: f.bSource, ids: parseIds(f.bIds) },
      }),
    })
    setBusy(false)
    if (!r.ok || !r.body?.plan) return setErr(String(r.body?.error ?? `HTTP ${r.status}`))
    setPlan(r.body.plan as SwapPlan)
    setMsg("Simulated on mainnet: every moment lands. Nothing has moved yet.")
  }

  const connect = async () => {
    setErr(null)
    try {
      await disconnectFlowWallet()
      setWallet(await connectFlowWallet())
    } catch (e) {
      setErr(errorText(e))
    }
  }

  const send = async () => {
    if (!plan) return
    setBusy(true)
    setErr(null)
    setLink(null)
    setMsg("Waiting for side A's wallet and the co-signer…")
    try {
      const { txId } = await sendSwap(plan, {
        post: async (cosigner, signable) => {
          const r = await call("/api/admin/swap-test", { method: "POST", body: JSON.stringify({ action: "relay_post", cosigner, signable }) })
          if (!r.ok || typeof r.body?.id !== "string") throw new Error(String(r.body?.error ?? `relay HTTP ${r.status}`))
          return r.body.id
        },
        waitForSignature: (id) => waitForRelaySignature((rid) => call(`/api/admin/swap-test?relay=${encodeURIComponent(rid)}`), id),
        onRelay: (id) => {
          setLink(`${window.location.origin}/admin/swap-test?relay=${id}`)
          setMsg("Open the co-signer link with side B's wallet and sign. Waiting (about 9 minutes max)…")
        },
      })
      setTxId(txId)
      setMsg("Sealed on chain: the swap executed.")
    } catch (e) {
      setErr(errorText(e))
      setMsg(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section style={box}>
        <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, marginTop: 0 }}>1 · Plan and simulate</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          {(["a", "b"] as const).map((s) => (
            <div key={s} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <strong style={{ fontFamily: DISPLAY }}>Side {s.toUpperCase()}</strong>
              <span style={label}>Signing Flow Wallet</span>
              <input style={input} value={f[`${s}Signer`]} onChange={set(`${s}Signer`)} />
              <span style={label}>Moments sit in (the wallet itself, or an account it links)</span>
              <input style={input} value={f[`${s}Source`]} onChange={set(`${s}Source`)} />
              <span style={label}>Top Shot moment ids it gives (comma-separated; may be empty)</span>
              <input style={input} value={f[`${s}Ids`]} onChange={set(`${s}Ids`)} />
            </div>
          ))}
        </div>
        <button type="button" style={{ ...btn, marginTop: 12 }} disabled={busy} onClick={simulate}>
          Simulate on mainnet
        </button>
      </section>

      <section style={box}>
        <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, marginTop: 0 }}>2 · Sign with side A, then side B</h2>
        <p style={{ fontSize: 13, color: "var(--rpc-text-muted)", marginTop: 0 }}>
          Connect side A&apos;s wallet here. After you press Sign and send, a co-signer link appears: open it on the device that has side B&apos;s
          wallet (another browser or your phone), sign there, and this page submits the transaction.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" style={btn} onClick={connect} disabled={busy}>
            {wallet ? "Reconnect Flow Wallet" : "Connect Flow Wallet (side A)"}
          </button>
          {wallet ? <code style={{ fontSize: 12 }}>{wallet}</code> : null}
          <button type="button" style={btn} onClick={send} disabled={busy || !plan || !wallet}>
            Sign and send
          </button>
        </div>
        {plan && wallet && wallet !== plan.a.signer ? (
          <p style={{ color: "var(--rpc-danger)", fontSize: 13 }}>This wallet is not side A&apos;s signer ({plan.a.signer}).</p>
        ) : null}
        {link ? (
          <p style={{ fontSize: 13, wordBreak: "break-all" }}>
            Co-signer link: <a href={link}>{link}</a>
          </p>
        ) : null}
        {txId ? (
          <p style={{ fontSize: 13 }}>
            Transaction:{" "}
            <a href={`https://www.flowscan.io/tx/${txId}`} target="_blank" rel="noreferrer">
              {txId}
            </a>
          </p>
        ) : null}
      </section>
      {msg ? <p style={{ fontSize: 13 }}>{msg}</p> : null}
      {err ? <p style={{ color: "var(--rpc-danger)", fontSize: 13 }}>{err}</p> : null}
    </>
  )
}

function CoSigner({ relayId, relay, loadError, loading, call }: { relayId: string; relay: RelayRow | null; loadError: string | null; loading: boolean; call: Call }) {
  const [wallet, setWallet] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (!relay) {
    return <section style={box}>{loading ? "Loading the swap request…" : <span style={{ color: "var(--rpc-danger)" }}>{loadError ?? "Couldn't load the swap request."}</span>}</section>
  }
  const d = describeSignable(relay.signable)

  const connect = async () => {
    setErr(null)
    try {
      await disconnectFlowWallet()
      setWallet(await connectFlowWallet())
    } catch (e) {
      setErr(errorText(e))
    }
  }

  const sign = async () => {
    setBusy(true)
    setErr(null)
    try {
      const { signature, keyId } = await coSign(relay.signable, relay.cosigner)
      const r = await call("/api/admin/swap-test", { method: "POST", body: JSON.stringify({ action: "relay_sign", id: relayId, signature, key_id: keyId }) })
      if (!r.ok) throw new Error(String(r.body?.error ?? `HTTP ${r.status}`))
      setDone(true)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={box}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, marginTop: 0 }}>Co-sign as side B</h2>
      {d.ok ? (
        <ul style={{ fontSize: 13, fontFamily: MONO, paddingLeft: 18 }}>
          <li>
            Side A gives {d.idsA.length ? d.idsA.join(", ") : "nothing"} from {d.sourceA} → to {d.sourceB}
          </li>
          <li>
            Side B gives {d.idsB.length ? d.idsB.join(", ") : "nothing"} from {d.sourceB} → to {d.sourceA}
          </li>
          <li>Signing wallet expected: {relay.cosigner}</li>
        </ul>
      ) : (
        <p style={{ color: "var(--rpc-danger)" }}>{d.reason}</p>
      )}
      {relay.signature || done ? (
        <p>Signed. Go back to the initiator&apos;s page; it submits the transaction.</p>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" style={btn} onClick={connect} disabled={busy}>
            {wallet ? "Reconnect Flow Wallet" : "Connect Flow Wallet (side B)"}
          </button>
          {wallet ? <code style={{ fontSize: 12 }}>{wallet}</code> : null}
          <button type="button" style={btn} onClick={sign} disabled={busy || !wallet || !d.ok}>
            Sign as side B
          </button>
        </div>
      )}
      {err ? <p style={{ color: "var(--rpc-danger)", fontSize: 13 }}>{err}</p> : null}
    </section>
  )
}
