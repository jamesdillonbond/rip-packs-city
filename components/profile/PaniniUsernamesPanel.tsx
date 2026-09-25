"use client"

// components/profile/PaniniUsernamesPanel.tsx
//
// Link a Panini username to your RPC profile (2026-09-25). A Panini owner is a
// USERNAME, not a wallet address, so it has its own field and its own route
// (/api/profile/collector-identities). ⚠ It must never share the dashboard's
// one-field add: that field sends any non-address string to the Top Shot
// resolver, where a Panini handle matching a Top Shot handle would attach
// someone else's Flow wallet.
//
// ⚠ What RPC can show is cards SEEN listed under the username on Panini's
// marketplace — the Panini data is listing-fed, so this is NOT a holdings
// count. The copy says so on every card.
//
// Three states for the list: failed to load (says so), none linked, linked.

import { useCallback, useEffect, useState } from "react"
import { fetchJson } from "@/lib/analytics/fetch-json"
import { formatCount } from "@/lib/format"

interface Summary {
  username: string
  cards_seen: number
  listed_now: number
  special_serials: number
  editions: number
  last_seen_at: string | null
}

interface Identity {
  collection: string
  username: string
  created_at: string
  summary: Summary | null
  summary_failed: boolean
}

const monoFont = "var(--font-mono)"
const condensedFont = "var(--font-display)"

export default function PaniniUsernamesPanel() {
  const [identities, setIdentities] = useState<Identity[]>([])
  const [loadState, setLoadState] = useState<"loading" | "failed" | "ok">("loading")
  const [input, setInput] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const r = await fetchJson<{ identities?: Identity[] }>("/api/profile/collector-identities", { cache: "no-store" })
    if (!r.ok || !Array.isArray(r.json?.identities)) {
      setLoadState("failed")
      return
    }
    setIdentities(r.json!.identities!.filter((i) => i.collection === "panini-blockchain"))
    setLoadState("ok")
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const link = useCallback(async () => {
    const username = input.trim()
    if (!username) {
      setError("Enter your Panini username")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/profile/collector-identities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(
          typeof data?.message === "string"
            ? data.message
            : typeof data?.error === "string"
              ? data.error
              : `Couldn't link that username (HTTP ${res.status}).`,
        )
        return
      }
      setInput("")
      await load()
    } catch {
      setError("Couldn't reach RPC. Try again in a moment.")
    } finally {
      setSaving(false)
    }
  }, [input, load])

  const unlink = useCallback(
    async (username: string) => {
      const res = await fetch("/api/profile/collector-identities", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      }).catch(() => null)
      if (!res || !res.ok) {
        setError(`Couldn't unlink ${username}. Try again.`)
        return
      }
      await load()
    },
    [load],
  )

  return (
    <section className="rpc-section" aria-labelledby="panini-usernames-title">
      <div id="panini-usernames-title" className="rpc-section-title">Panini Username</div>
      <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
        Panini collectors are identified by username, not a wallet address. Link yours to track the cards RPC has
        seen listed under it on Panini&rsquo;s marketplace. Counts toward your 5 saved wallets.
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void link()
          }}
          placeholder="Panini username"
          aria-label="Panini username"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          maxLength={17}
          style={{
            flex: 1,
            minWidth: 200,
            padding: "10px 12px",
            background: "var(--rpc-surface)",
            border: "1px solid var(--rpc-border)",
            borderRadius: 6,
            color: "var(--rpc-text-primary)",
            fontFamily: monoFont,
            fontSize: 13,
          }}
        />
        <button onClick={() => void link()} disabled={saving} className="rpc-btn-primary">
          {saving ? "Linking…" : "Link username"}
        </button>
      </div>
      {error && (
        <div role="alert" style={{ color: "var(--rpc-danger)", fontFamily: monoFont, fontSize: 11, marginBottom: 10 }}>
          {error}
        </div>
      )}

      {loadState === "failed" ? (
        <div role="status" style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-secondary)" }}>
          Couldn&rsquo;t load your linked Panini usernames. This is a loading problem — nothing has been unlinked.
        </div>
      ) : loadState === "ok" && identities.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {identities.map((i) => (
            <div
              key={i.username}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                padding: "10px 12px",
                background: "var(--rpc-surface)",
                border: "1px solid var(--rpc-border)",
                borderRadius: 6,
              }}
            >
              <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)" }}>
                {i.username}
              </div>
              <div style={{ flex: 1, minWidth: 200, fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                {i.summary ? (
                  <>
                    {formatCount(i.summary.cards_seen)} cards seen · {formatCount(i.summary.listed_now)} listed now ·{" "}
                    {formatCount(i.summary.special_serials)} special serials · {formatCount(i.summary.editions)} editions
                    <span style={{ color: "var(--rpc-text-muted)" }}> — listing-based, not full holdings</span>
                  </>
                ) : i.summary_failed ? (
                  <>Couldn&rsquo;t load this username&rsquo;s cards right now.</>
                ) : null}
              </div>
              <button
                onClick={() => void unlink(i.username)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--rpc-text-muted)",
                  fontFamily: monoFont,
                  fontSize: 11,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                Unlink
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
