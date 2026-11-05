"use client"

// app/admin/storage-fix/StorageFixClient.tsx
//
// Admin-only (Trevor, 2026-11-05): paste a Flow address that is stuck on storage
// ("[Error Code: 1103] storage limit check failed"), see whether it is still stuck and
// whether someone (often Dapper) already topped it up, then send the fix from your own
// Flow Wallet. A Dapper wallet gets DapperStorageRent.fundedRefillV2 (the only way FLOW
// reaches one); any other account gets a plain FLOW transfer. Immediately before the wallet
// opens, the address is RE-CHECKED and the fix is SIMULATED on mainnet as the connected wallet
// (the transaction's own statements, run as a read-only script): a refill that landed
// meanwhile, or a fix that would revert, stops the send before anything is signed.

import { useCallback, useState } from "react"
import Link from "next/link"
import { useAdminResource } from "@/lib/admin/use-admin-resource"
import { errorText } from "@/lib/giveaways/view-format"
import type { StorageCheck } from "@/lib/storage-fix/check"
import { bytes, flow, flowscanAccount, flowscanTx, historyLine, verdict } from "@/lib/storage-fix/view"
import { connectFlowWallet, disconnectFlowWallet, SealUnconfirmedError, sendStorageFix } from "@/lib/storage-fix/wallet"

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
const toneColor = { ok: "var(--rpc-success-text)", warn: "var(--rpc-warning-text)", bad: "var(--rpc-danger-text)" } as const

type Sent = { kind: "sealed"; txId: string } | { kind: "unconfirmed"; txId: string; message: string } | { kind: "failed"; message: string }

export default function StorageFixClient() {
  const res = useAdminResource<unknown>(null)
  const { token } = res

  const [address, setAddress] = useState("")
  const [check, setCheck] = useState<StorageCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [amount, setAmount] = useState("")
  const [force, setForce] = useState(false)
  const [wallet, setWallet] = useState<string | null>(null)
  const [walletError, setWalletError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [slowHint, setSlowHint] = useState<string | null>(null)
  const [sent, setSent] = useState<Sent | null>(null)
  const [simulated, setSimulated] = useState<string | null>(null)

  const runCheck = useCallback(
    async (addr: string, simulate?: { from: string; amount: string }): Promise<StorageCheck | null> => {
      setChecking(true)
      setCheckError(null)
      const sim = simulate ? `&simulate_from=${encodeURIComponent(simulate.from)}&amount=${encodeURIComponent(simulate.amount)}` : ""
      try {
        const r = await fetch(`/api/admin/storage-fix?address=${encodeURIComponent(addr.trim())}${sim}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        })
        let body: { check?: StorageCheck; error?: string } | null = null
        try {
          body = (await r.json()) as { check?: StorageCheck; error?: string }
        } catch {
          setCheckError(`HTTP ${r.status}: unreadable response`)
          return null
        }
        if (!r.ok || !body?.check) {
          setCheckError(body?.error ?? `HTTP ${r.status}`)
          return null
        }
        setCheck(body.check)
        return body.check
      } catch (e) {
        setCheckError(errorText(e))
        return null
      } finally {
        setChecking(false)
      }
    },
    [token],
  )

  const onCheck = async () => {
    setSent(null)
    setForce(false)
    const c = await runCheck(address)
    if (c?.plan.amount) setAmount(String(Number(c.plan.amount)))
  }

  const onConnect = async () => {
    setWalletError(null)
    try {
      await disconnectFlowWallet()
      setWallet(await connectFlowWallet())
    } catch (e) {
      setWalletError(errorText(e))
    }
  }

  const onDisconnect = async () => {
    await disconnectFlowWallet().catch(() => undefined)
    setWallet(null)
  }

  const onSend = async () => {
    if (!check) return
    setSent(null)
    setSlowHint(null)
    setSimulated(null)
    if (!wallet) return
    const n = Number(amount)
    if (!Number.isFinite(n) || n < 0.01 || n > 1) {
      setSent({ kind: "failed", message: "Amount must be between 0.01 and 1 FLOW." })
      return
    }
    // re-check the chain and simulate the fix as THIS wallet, right before the wallet opens
    const fresh = await runCheck(check.address, { from: wallet, amount: n.toFixed(8) })
    if (!fresh) return
    if (fresh.plan.kind === "none") {
      setSent({ kind: "failed", message: fresh.plan.reason })
      return
    }
    if (!fresh.plan.stuck && !force) {
      setSent({ kind: "failed", message: "Re-checked just now: it is no longer stuck, so nothing was sent. Tick \"send anyway\" to send regardless." })
      return
    }
    const sim = fresh.simulation
    if (!sim || !sim.ok) {
      setSent({ kind: "failed", message: `The simulation refused, so nothing was signed: ${sim && !sim.ok ? sim.reason : "no simulation came back"}.` })
      return
    }
    setSimulated(`Simulated as ${sim.signer}: capacity ${bytes(sim.capacityBefore)} → ${bytes(sim.capacityAfter)}. Approve it in your wallet.`)
    setSending(true)
    try {
      const { txId } = await sendStorageFix(
        { kind: sim.kind, receiver: fresh.address, amount: sim.amount },
        { onSlow: (hint) => setSlowHint(hint) },
      )
      setSent({ kind: "sealed", txId })
      await runCheck(fresh.address)
    } catch (e) {
      if (e instanceof SealUnconfirmedError) setSent({ kind: "unconfirmed", txId: e.txId, message: e.message })
      else setSent({ kind: "failed", message: errorText(e) })
    } finally {
      setSending(false)
      setSlowHint(null)
    }
  }

  if (!token) {
    return (
      <main style={{ maxWidth: 520, margin: "40px auto", padding: 16 }}>
        <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase" }}>Storage fix</h1>
        <p style={{ color: "var(--rpc-text-muted)" }}>Admin token required.</p>
        <input type="password" value={res.tokenInput} onChange={(e) => res.setTokenInput(e.target.value)} style={input} />
        <button type="button" onClick={res.submitToken} style={{ ...btn, marginTop: 8 }}>
          Continue
        </button>
        {res.error ? <p style={{ color: "var(--rpc-danger-text)" }}>{res.error}</p> : null}
      </main>
    )
  }

  const v = check ? verdict(check) : null
  const canSend = !!check && check.plan.kind !== "none" && (check.plan.stuck || force)

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "24px 16px 80px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <Link href="/admin" style={{ color: "var(--rpc-text-muted)", fontSize: 13 }}>
          ← Admin
        </Link>
        <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: "8px 0 4px" }}>Flow storage fix</h1>
        <p style={{ color: "var(--rpc-text-muted)", margin: 0, fontSize: 14 }}>
          For a collector stuck on &quot;Error Code: 1103, storage limit check failed&quot;. Checks the account on mainnet, says whether it was
          already topped up, and sends the fix from your own Flow Wallet. RPC never holds a key.
        </p>
      </div>

      <section style={box}>
        <div style={label}>Stuck account</div>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => (e.key === "Enter" ? void onCheck() : undefined)}
            placeholder="0x9124f9b74b02e86e"
            style={input}
            aria-label="Flow address"
          />
          <button type="button" onClick={() => void onCheck()} disabled={checking || !address.trim()} style={btn}>
            {checking ? "Checking…" : "Check"}
          </button>
        </div>
        {checkError ? <p style={{ color: "var(--rpc-danger-text)", marginBottom: 0 }}>{checkError}</p> : null}
      </section>

      {check && v ? (
        <section style={{ ...box, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ color: toneColor[v.tone], fontWeight: 600 }}>{v.text}</div>
          <div style={{ fontFamily: MONO, fontSize: 13, display: "grid", gridTemplateColumns: "minmax(110px, auto) 1fr", gap: "4px 12px" }}>
            <span style={label}>Account</span>
            <a href={flowscanAccount(check.address)} target="_blank" rel="noreferrer">
              {check.address}
            </a>
            <span style={label}>Used</span>
            <span>{bytes(check.state.usedBytes)}</span>
            <span style={label}>Capacity</span>
            <span>{bytes(check.state.capacityBytes)}</span>
            <span style={label}>FLOW held</span>
            <span>{check.state.balanceFlow == null ? "unreadable" : flow(check.state.balanceFlow)}</span>
            <span style={label}>Wallet type</span>
            <span>{check.state.isDapperWallet ? "Dapper wallet (needs the Dapper refill)" : check.state.hasFlowReceiver ? "Not Dapper (plain FLOW transfer)" : "No way in from here"}</span>
            <span style={label}>History</span>
            <span>
              {historyLine(check.history)}
              {check.history.status === "found" && check.history.change.txId ? (
                <>
                  {" "}
                  <a href={flowscanTx(check.history.change.txId)} target="_blank" rel="noreferrer">
                    View transaction
                  </a>
                </>
              ) : null}
            </span>
          </div>
          <p style={{ color: "var(--rpc-text-muted)", fontSize: 13, margin: 0 }}>{check.plan.reason}</p>
        </section>
      ) : null}

      {check && check.plan.kind !== "none" ? (
        <section style={{ ...box, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={label}>Send the fix</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {wallet ? (
              <>
                <span style={{ fontFamily: MONO, fontSize: 13 }}>Signing as {wallet}</span>
                <button type="button" onClick={() => void onDisconnect()} style={btn}>
                  Disconnect
                </button>
              </>
            ) : (
              <button type="button" onClick={() => void onConnect()} style={btn}>
                Connect Flow Wallet
              </button>
            )}
          </div>
          {walletError ? <p style={{ color: "var(--rpc-danger-text)", margin: 0 }}>{walletError}</p> : null}
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            Amount (FLOW)
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              style={{ ...input, width: 120 }}
              aria-label="Amount in FLOW"
            />
            <span style={{ color: "var(--rpc-text-muted)" }}>
              ≈ {bytes(Math.max(0, Number(amount) || 0) * check.state.megabytesPerFlow * 1_000_000)} of storage
            </span>
          </label>
          {!check.plan.stuck ? (
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              It isn&apos;t stuck right now: send anyway
            </label>
          ) : null}
          <div>
            <button type="button" onClick={() => void onSend()} disabled={!wallet || !canSend || sending || checking} style={btn}>
              {sending
                ? "Waiting for your wallet…"
                : `Send ${flow(Number(amount) || 0)} ${check.plan.kind === "dapper_refill" ? "Dapper refill" : "transfer"} to ${check.address}`}
            </button>
          </div>
          <p style={{ color: "var(--rpc-text-muted)", fontSize: 12, margin: 0 }}>
            Re-checks the account and simulates the fix on mainnet as your wallet first, and stops if it is no longer stuck or the
            simulation fails. The full amount leaves your wallet; your wallet also pays the network fee.
          </p>
          {simulated ? <p style={{ margin: 0, fontSize: 13 }}>{simulated}</p> : null}
          {slowHint ? <p style={{ margin: 0, fontSize: 13 }}>{slowHint}</p> : null}
          {sent?.kind === "sealed" ? (
            <p style={{ margin: 0, color: toneColor.ok }}>
              Sealed.{" "}
              <a href={flowscanTx(sent.txId)} target="_blank" rel="noreferrer">
                {sent.txId}
              </a>
            </p>
          ) : null}
          {sent?.kind === "unconfirmed" ? (
            <p style={{ margin: 0 }}>
              {sent.message}{" "}
              <a href={flowscanTx(sent.txId)} target="_blank" rel="noreferrer">
                Check it on Flowscan
              </a>
            </p>
          ) : null}
          {sent?.kind === "failed" ? <p style={{ margin: 0, color: "var(--rpc-danger-text)" }}>{sent.message}</p> : null}
        </section>
      ) : null}
    </main>
  )
}
