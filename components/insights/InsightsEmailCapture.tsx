// components/insights/InsightsEmailCapture.tsx
//
// Anon lead-capture band for the public /insights surfaces. POSTs to the
// unauthenticated /api/subscribe route, which upserts email_subscribers and
// sends a Resend double-opt-in confirmation email. No account required — this
// is the top-of-funnel capture for the free wedge content.

"use client"

import { useState } from "react"

type Status = "idle" | "sending" | "sent" | "error"

export default function InsightsEmailCapture() {
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
        body: JSON.stringify({ email: trimmed, digestWeekly: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.success !== false) {
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
    <section className="rpc-ins-capture">
      <style>{CSS}</style>
      <div className="rpc-ins-capture-inner">
        {status === "sent" ? (
          <div className="rpc-ins-capture-done">
            <div className="rpc-ins-capture-done-title">Check your inbox ✉️</div>
            <div className="rpc-ins-capture-done-sub">
              We sent a confirmation link to <strong>{email.trim().toLowerCase()}</strong>. Click it
              to start getting the weekly intelligence digest.
            </div>
          </div>
        ) : (
          <>
            <div className="rpc-ins-capture-copy">
              <div className="rpc-ins-capture-eyebrow">Get the weekly digest</div>
              <h2 className="rpc-ins-capture-title">
                The numbers, in your inbox.
              </h2>
              <p className="rpc-ins-capture-lede">
                Squeeze movers, fresh +EV packs, and rookie-cohort shifts — once a week. Free, no
                account needed. Unsubscribe any time.
              </p>
            </div>
            <form className="rpc-ins-capture-form" onSubmit={handleSubmit}>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={status === "sending"}
                className="rpc-ins-capture-input"
                aria-label="Email address"
              />
              <button
                type="submit"
                disabled={status === "sending"}
                className="rpc-ins-capture-btn"
              >
                {status === "sending" ? "Sending…" : "Subscribe →"}
              </button>
              {status === "error" && error ? (
                <div className="rpc-ins-capture-err">{error}</div>
              ) : null}
            </form>
          </>
        )}
      </div>
    </section>
  )
}

const CSS = `
.rpc-ins-capture {
  border-top: 1px solid var(--rpc-border-subtle);
  background: var(--rpc-surface);
  padding: 40px 20px;
}
.rpc-ins-capture-inner {
  max-width: 1180px;
  margin: 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.rpc-ins-capture-copy { max-width: 560px; }
.rpc-ins-capture-eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: var(--rpc-red);
  margin-bottom: 10px;
}
.rpc-ins-capture-title {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(26px, 4vw, 38px);
  line-height: 1.05;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 8px;
  color: var(--rpc-text-primary);
}
.rpc-ins-capture-lede {
  font-size: 14px;
  line-height: 1.55;
  color: var(--rpc-text-secondary);
  margin: 0;
}
.rpc-ins-capture-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  min-width: 280px;
}
.rpc-ins-capture-input {
  flex: 1;
  min-width: 220px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--rpc-red-border);
  color: var(--rpc-text-primary);
  font-family: var(--font-mono);
  font-size: 14px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  outline: none;
}
.rpc-ins-capture-input::placeholder { color: rgba(255,255,255,0.28); }
.rpc-ins-capture-btn {
  background: var(--rpc-red);
  border: none;
  color: #fff;
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 13px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 12px 22px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
}
.rpc-ins-capture-btn:disabled { opacity: 0.6; cursor: wait; }
.rpc-ins-capture-err {
  flex-basis: 100%;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--rpc-danger);
}
.rpc-ins-capture-done-title {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 22px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--rpc-text-primary);
  margin-bottom: 8px;
}
.rpc-ins-capture-done-sub {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--rpc-text-secondary);
}
@media (max-width: 760px) {
  .rpc-ins-capture-form { width: 100%; }
}
`
