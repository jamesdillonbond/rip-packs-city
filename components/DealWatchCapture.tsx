// components/DealWatchCapture.tsx
//
// Anon email-capture at the value moment: shown on the public /share/<wallet>
// analyzer result once a wallet's FMV has rendered. Converts an anonymous
// searcher into a lead (and a reason to come back) WITHOUT requiring an
// account. POSTs to the existing unauthenticated /api/subscribe route with
// dealAlerts + the wallet, which upserts email_subscribers and sends a Resend
// double-opt-in confirmation. Fires the email_capture_submitted funnel event so
// the signup funnel is measurable.

"use client"

import { useState } from "react"
import { trackFunnelEvent } from "@/lib/track-funnel"

type Status = "idle" | "sending" | "sent" | "error"

export default function DealWatchCapture({ wallet }: { wallet: string }) {
  const [email, setEmail] = useState("")
  const [status, setStatus] = useState<Status>("idle")
  const [error, setError] = useState("")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = email.trim().toLowerCase()
    if (!trimmed || !trimmed.includes("@")) {
      setError("Enter a valid email.")
      setStatus("error")
      return
    }
    setStatus("sending")
    setError("")
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: trimmed,
          walletAddress: wallet,
          dealAlerts: true,
          digestWeekly: true,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.success !== false) {
        // Funnel: an anon searcher left an email at the value moment.
        trackFunnelEvent({
          eventType: "email_capture_submitted",
          walletAddress: wallet,
          surface: "share",
        })
        setStatus("sent")
        return
      }
      setError(typeof data?.error === "string" ? data.error : "Something went wrong — try again.")
      setStatus("error")
    } catch {
      setError("Network error — try again.")
      setStatus("error")
    }
  }

  return (
    <section className="rpc-dw-capture">
      <style>{CSS}</style>
      {status === "sent" ? (
        <div className="rpc-dw-done">
          <div className="rpc-dw-done-title">Check your inbox ✉️</div>
          <div className="rpc-dw-done-sub">
            We sent a confirmation link to <strong>{email.trim().toLowerCase()}</strong>. Click it
            and we&apos;ll email you when a moment in this collection drops below FMV.
          </div>
        </div>
      ) : (
        <>
          <div className="rpc-dw-copy">
            <div className="rpc-dw-eyebrow">Deal watch</div>
            <div className="rpc-dw-title">Email me when a moment here drops below FMV</div>
            <div className="rpc-dw-lede">
              Free, no account needed. We&apos;ll watch this collection and ping you on
              underpriced moments. Unsubscribe any time.
            </div>
          </div>
          <form className="rpc-dw-form" onSubmit={handleSubmit}>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={status === "sending"}
              className="rpc-dw-input"
              aria-label="Email address"
            />
            <button type="submit" disabled={status === "sending"} className="rpc-dw-btn">
              {status === "sending" ? "Sending…" : "Watch for deals →"}
            </button>
            {status === "error" && error ? <div className="rpc-dw-err">{error}</div> : null}
          </form>
        </>
      )}
    </section>
  )
}

const CSS = `
.rpc-dw-capture {
  margin: 20px auto 0;
  max-width: 720px;
  width: 100%;
  border: 1px solid var(--rpc-red-border);
  background: rgba(224,58,47,0.06);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.rpc-dw-copy { max-width: 380px; }
.rpc-dw-eyebrow {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--rpc-red);
  margin-bottom: 6px;
}
.rpc-dw-title {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 17px;
  line-height: 1.15;
  color: var(--rpc-text-primary);
  margin-bottom: 6px;
}
.rpc-dw-lede {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--rpc-text-secondary);
}
.rpc-dw-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-width: 260px;
  flex: 1;
}
.rpc-dw-input {
  flex: 1;
  min-width: 180px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--rpc-red-border);
  color: var(--rpc-text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  padding: 11px 13px;
  border-radius: var(--radius-sm);
  outline: none;
}
.rpc-dw-input::placeholder { color: rgba(255,255,255,0.28); }
.rpc-dw-btn {
  background: var(--rpc-red);
  border: none;
  color: #fff;
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 11px 18px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
}
.rpc-dw-btn:disabled { opacity: 0.6; cursor: wait; }
.rpc-dw-err {
  flex-basis: 100%;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--rpc-danger);
}
.rpc-dw-done-title {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 18px;
  color: var(--rpc-text-primary);
  margin-bottom: 6px;
}
.rpc-dw-done-sub {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--rpc-text-secondary);
}
@media (max-width: 620px) {
  .rpc-dw-form { width: 100%; }
}
`
