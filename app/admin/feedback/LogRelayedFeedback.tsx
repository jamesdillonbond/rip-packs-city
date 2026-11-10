"use client";

// app/admin/feedback/LogRelayedFeedback.tsx
// "Log feedback from outside the site" (2026-11-10). Feedback that reaches the
// team by Discord, X, a text or email goes into the same queue as concierge
// feedback, so it has a status and its reader gets the "shipped" email (when
// they have an RPC account) — see lib/feedback/relayed.ts. Posts to
// POST /api/admin/feedback with the stored admin token.

import { useState } from "react";
import { getAdminToken } from "@/lib/admin-token";
import { accentText } from "@/lib/accent-text";
import { RELAYED_CHANNELS, RELAYED_TYPES, CHANNEL_LABEL, type RelayedChannel } from "@/lib/feedback/relayed";

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 5,
  color: "inherit",
  padding: "7px 9px",
  fontSize: 13,
  fontFamily: "var(--font-mono)",
}

export default function LogRelayedFeedback({ onLogged, onUnauthorized }: { onLogged: () => void; onUnauthorized: () => void }) {
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState("")
  const [message, setMessage] = useState("")
  const [type, setType] = useState<string>("bug")
  const [channel, setChannel] = useState<string>("discord")
  const [username, setUsername] = useState("")
  const [state, setState] = useState<"idle" | "saving" | "done" | "failed">("idle")
  const [result, setResult] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const t = getAdminToken()
    if (!t) return onUnauthorized()
    setState("saving")
    setResult(null)
    try {
      const res = await fetch("/api/admin/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ summary, message, feedback_type: type, channel, username: username || null }),
      })
      if (res.status === 401) return onUnauthorized()
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        setState("failed")
        setResult(data?.error || `HTTP ${res.status}`)
        return
      }
      setState("done")
      setResult(
        `Logged #${data.row?.id}. ` +
          (data.reader_emailable
            ? "Their account email is on the row — marking it Shipped emails them."
            : `No email on the row (${data.email_reason ?? "unknown"}) — reply in ${CHANNEL_LABEL[channel as RelayedChannel] ?? "the channel"} when it ships.`)
      )
      setSummary("")
      setMessage("")
      setUsername("")
      onLogged()
    } catch (err) {
      setState("failed")
      setResult(err instanceof Error ? err.message : "Network error")
    }
  }

  return (
    <section className="rpc-section" data-testid="log-relayed-feedback" style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ alignSelf: "flex-start", background: "transparent", border: "none", color: "inherit", cursor: "pointer", fontWeight: 700, padding: 0 }}>
        {open ? "▾" : "▸"} Log feedback from Discord, X, a text or email
      </button>
      {open && (
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 }}>
          <span style={{ color: "rgba(255,255,255,0.65)" }}>
            Anything we act on goes in the queue first, so it has a status and the person hears when it ships.
          </span>
          <input aria-label="Summary" placeholder="One line: what they asked for" value={summary} onChange={(e) => setSummary(e.target.value)} style={inputStyle} required minLength={5} maxLength={200} />
          <textarea aria-label="Their words" placeholder="Their words (optional)" value={message} onChange={(e) => setMessage(e.target.value)} style={{ ...inputStyle, minHeight: 60 }} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} style={inputStyle}>
              {RELAYED_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
            </select>
            <select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)} style={inputStyle}>
              {RELAYED_CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
            </select>
            <input aria-label="RPC username" placeholder="RPC username (if they have one)" spellCheck={false} autoCapitalize="none" autoCorrect="off" value={username} onChange={(e) => setUsername(e.target.value)} style={inputStyle} />
            <button type="submit" disabled={state === "saving"} style={{ ...inputStyle, cursor: "pointer", fontWeight: 700 }}>
              {state === "saving" ? "Logging…" : "Log it"}
            </button>
          </div>
        </form>
      )}
      {result && (
        <div role="status" data-testid="log-relayed-result" style={{ color: state === "failed" ? accentText("#fca5a5") : "rgba(255,255,255,0.75)" }}>
          {result}
        </div>
      )}
    </section>
  )
}
