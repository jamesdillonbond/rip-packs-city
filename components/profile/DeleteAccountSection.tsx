"use client"

// components/profile/DeleteAccountSection.tsx
//
// The "delete my account" control on /profile/edit. Calls
// DELETE /api/profile/account with the typed confirmation, then clears every
// chain's owner-key slot and sends the browser home.
//
// Honesty rules this component follows:
//   * a refused or failed delete is STATED, with the server's reason when it
//     gives one, and the account is described as still intact; it never shows
//     the success copy on a non-OK answer;
//   * the destructive request only goes out after the user has typed the
//     confirmation phrase, so a mis-click cannot reach the server;
//   * on success nothing user-specific is left in localStorage.

import { useState } from "react"
import { clearAllOwnerKeys } from "@/lib/owner-key"

const CONFIRM_PHRASE = "DELETE"
const condensedFont = "var(--font-display)"
const monoFont = "var(--font-mono)"

type Phase = "idle" | "confirming" | "deleting" | "done"

export default function DeleteAccountSection() {
  const [phase, setPhase] = useState<Phase>("idle")
  const [typed, setTyped] = useState("")
  const [error, setError] = useState<string | null>(null)

  const armed = typed.trim() === CONFIRM_PHRASE

  async function deleteAccount() {
    if (!armed || phase === "deleting") return
    setPhase("deleting")
    setError(null)
    let res: Response | null = null
    try {
      res = await fetch("/api/profile/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: CONFIRM_PHRASE }),
      })
    } catch {
      res = null
    }
    if (!res) {
      setError("Couldn't reach RPC. Your account is unchanged; try again in a moment.")
      setPhase("confirming")
      return
    }
    if (!res.ok) {
      let reason = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { detail?: unknown; error?: unknown }
        if (typeof body?.detail === "string") reason = body.detail
        else if (typeof body?.error === "string") reason = body.error
      } catch {
        // keep the status
      }
      setError(`Couldn't delete your account (${reason}). Nothing was removed unless the message above says otherwise.`)
      setPhase("confirming")
      return
    }
    clearAllOwnerKeys()
    setPhase("done")
    if (typeof window !== "undefined") {
      window.location.href = "/"
    }
  }

  return (
    <section
      aria-labelledby="delete-account-title"
      style={{
        marginTop: 24,
        background: "var(--rpc-surface)",
        border: "1px solid var(--rpc-border)",
        borderRadius: 10,
        padding: "18px 18px 22px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <h2
        id="delete-account-title"
        style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 16, letterSpacing: "0.06em", textTransform: "uppercase", margin: 0, color: "var(--rpc-text-secondary)" }}
      >
        Delete account
      </h2>
      <p style={{ margin: 0, fontFamily: monoFont, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-secondary)" }}>
        Permanently removes your account and everything stored against it: saved wallets, bio, trophies,
        teams, watchlists, alerts, rewards and concierge history. Anonymous usage counts that no longer
        identify you may remain. This cannot be undone.
      </p>

      {phase === "idle" && (
        <div>
          <button
            type="button"
            onClick={() => setPhase("confirming")}
            style={{
              fontFamily: condensedFont,
              fontWeight: 700,
              fontSize: 13,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              padding: "8px 16px",
              background: "transparent",
              color: "var(--rpc-red-text)",
              border: "1px solid var(--rpc-red)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Delete my account…
          </button>
        </div>
      )}

      {(phase === "confirming" || phase === "deleting") && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label htmlFor="delete-account-confirm" style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-primary)" }}>
            Type <strong>{CONFIRM_PHRASE}</strong> to confirm
          </label>
          <input
            id="delete-account-confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={phase === "deleting"}
            style={{
              fontFamily: monoFont,
              fontSize: 13,
              padding: "8px 10px",
              maxWidth: 220,
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              borderRadius: 6,
              color: "var(--rpc-text-primary)",
            }}
          />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={deleteAccount}
              disabled={!armed || phase === "deleting"}
              style={{
                fontFamily: condensedFont,
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "8px 16px",
                background: armed ? "var(--rpc-red-fill)" : "var(--rpc-surface-hover)",
                // brand-exception: white text on the --rpc-red destructive button
                color: armed ? "#fff" : "var(--rpc-text-muted)",
                border: "none",
                borderRadius: 6,
                cursor: armed && phase !== "deleting" ? "pointer" : "not-allowed",
                opacity: phase === "deleting" ? 0.6 : 1,
              }}
            >
              {phase === "deleting" ? "Deleting…" : "Permanently delete"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPhase("idle")
                setTyped("")
                setError(null)
              }}
              disabled={phase === "deleting"}
              style={{
                fontFamily: condensedFont,
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "8px 16px",
                background: "transparent",
                color: "var(--rpc-text-secondary)",
                border: "1px solid var(--rpc-border)",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div role="status" style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-primary)" }}>
          Your account has been deleted. Taking you home…
        </div>
      )}

      {error && (
        <div role="alert" style={{ fontFamily: monoFont, fontSize: 12, lineHeight: 1.5, color: "var(--rpc-red-text)" }}>
          {error}
        </div>
      )}
    </section>
  )
}
