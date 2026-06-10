// app/early-access/page.tsx
//
// Public soft-launch sign-up page. Captures email + (optional wallet OR
// username) + which collections the user holds, POSTs to
// /api/early-access/submit which proxies to the submit_allow_list_request RPC.

"use client"

import { useMemo, useState } from "react"
import Link from "next/link"

const condensedFont = "var(--font-display)"
const monoFont = "var(--font-mono)"

const COLLECTION_OPTIONS: { slug: string; label: string }[] = [
  { slug: "nba_top_shot",   label: "NBA Top Shot" },
  { slug: "nfl_all_day",    label: "NFL All Day" },
  { slug: "laliga_golazos", label: "LaLiga Golazos" },
  { slug: "disney_pinnacle", label: "Disney Pinnacle" },
  { slug: "ufc_strike",     label: "UFC Strike" },
]

const WALLET_RE = /^0x[a-fA-F0-9]{16}$/

type Status = "idle" | "submitting" | "success" | "error"

export default function EarlyAccessPage() {
  const [email, setEmail] = useState("")
  const [wallet, setWallet] = useState("")
  const [username, setUsername] = useState("")
  const [collections, setCollections] = useState<string[]>([])
  const [status, setStatus] = useState<Status>("idle")
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState(false)
  // Non-blocking "this wallet shows 0 Top Shot moments on-chain" nudge — two of
  // the first organic signups typed a wrong/empty wallet that needed manual SQL
  // to fix. Fired once per blur (not per keystroke); never blocks submission.
  const [walletWarning, setWalletWarning] = useState<string | null>(null)

  const walletValid = wallet.length === 0 || WALLET_RE.test(wallet.trim())
  const hasIdentifier = wallet.trim().length > 0 || username.trim().length > 0

  const formError = useMemo(() => {
    if (!email.trim()) return "Email is required."
    if (!walletValid) return "Wallet must be 0x followed by exactly 16 hex characters."
    if (!hasIdentifier) return "Add either a Flow wallet address or a username so we can pre-warm your data."
    return null
  }, [email, walletValid, hasIdentifier])

  function toggleCollection(slug: string) {
    setCollections((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]))
  }

  // On wallet-field blur, check the on-chain Top Shot moment count via the
  // public /api/wallet-search route. Only runs on a well-formed address, fails
  // silent on any error/timeout, and never blocks submit (Golazos/UFC-only
  // collectors legitimately have 0 TS moments).
  async function checkWalletOnChain() {
    const w = wallet.trim()
    setWalletWarning(null)
    if (!w || !WALLET_RE.test(w)) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const res = await fetch("/api/wallet-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: w, collection: "nba-top-shot" }),
        signal: controller.signal,
      })
      if (!res.ok) return
      const data = await res.json().catch(() => null)
      const tm = data?.summary?.totalMoments
      // Guard against a stale result landing after the field was edited.
      if (typeof tm === "number" && tm === 0 && wallet.trim() === w) {
        setWalletWarning(
          "This wallet shows 0 Top Shot moments on-chain — double-check it. You can find your address in your Dapper account settings. (Golazos/UFC-only collectors can ignore this.)"
        )
      }
    } catch {
      // fail silent — this is a best-effort nudge, not validation.
    } finally {
      clearTimeout(timer)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (formError) {
      setErrorMsg(formError)
      setStatus("error")
      return
    }
    setStatus("submitting")
    setErrorMsg(null)
    setDuplicate(false)
    try {
      const res = await fetch("/api/early-access/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          wallet: wallet.trim() || null,
          username: username.trim() || null,
          collections,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`)
      }
      setDuplicate(Boolean(data.duplicate))
      setStatus("success")
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong — please try again."
      setErrorMsg(msg)
      setStatus("error")
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#000",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "48px 20px",
        fontFamily: monoFont,
      }}
    >
      <style>{`
        input::placeholder { color: rgba(255,255,255,0.3); }
      `}</style>

      <div style={{ width: "100%", maxWidth: 560 }}>
        <div
          style={{
            fontFamily: monoFont,
            fontSize: 10,
            letterSpacing: "0.2em",
            color: "rgba(255,255,255,0.5)",
            textTransform: "uppercase",
            marginBottom: 12,
          }}
        >
          Rip Packs City · Early Access
        </div>

        <h1
          style={{
            fontFamily: condensedFont,
            fontWeight: 900,
            fontSize: 36,
            letterSpacing: "0.03em",
            textTransform: "uppercase",
            lineHeight: 1.05,
            marginBottom: 14,
          }}
        >
          Get on the soft-launch list
        </h1>
        <p style={{ fontSize: 13, lineHeight: 1.65, color: "rgba(255,255,255,0.7)", marginBottom: 28 }}>
          RPC is collector intelligence for Flow blockchain digital collectibles — wallet
          analytics, FMV pricing, deal-finding, and pack EV across NBA Top Shot, NFL All Day,
          LaLiga Golazos, Disney Pinnacle, and UFC Strike. Drop your email and we&apos;ll let
          you in as we open access.
        </p>

        {status === "success" ? (
          <SuccessCard duplicate={duplicate} />
        ) : (
          <form
            onSubmit={handleSubmit}
            className="bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl"
            style={{
              padding: 24,
              display: "flex",
              flexDirection: "column",
              gap: 18,
            }}
          >
            <Field label="Email" required>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                style={inputStyle}
              />
            </Field>

            <Field
              label="Flow wallet address"
              hint="Optional — 0x followed by exactly 16 hex characters."
            >
              <input
                type="text"
                value={wallet}
                onChange={(e) => {
                  setWallet(e.target.value)
                  // Clear any stale on-chain nudge while the user is editing.
                  if (walletWarning) setWalletWarning(null)
                }}
                onBlur={checkWalletOnChain}
                placeholder="0x1234567890abcdef"
                style={{
                  ...inputStyle,
                  borderColor:
                    wallet.length > 0 && !walletValid ? "#F87171" : "#27272a",
                }}
                aria-invalid={wallet.length > 0 && !walletValid}
              />
              {wallet.length > 0 && !walletValid && (
                <div style={{ marginTop: 6, fontSize: 11, color: "#F87171" }}>
                  Wallet must be 0x + 16 hex characters.
                </div>
              )}
              {walletValid && walletWarning && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: "#FBBF24",
                    background: "rgba(251,191,36,0.08)",
                    border: "1px solid rgba(251,191,36,0.3)",
                    borderRadius: 6,
                    padding: "8px 10px",
                  }}
                >
                  {walletWarning}
                </div>
              )}
            </Field>

            <Field label="Flow username" hint="Optional — your Top Shot / All Day handle.">
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. jamesdillonbond"
                style={inputStyle}
                autoComplete="off"
              />
            </Field>

            <div>
              <Label>Which collections do you hold?</Label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                {COLLECTION_OPTIONS.map((c) => {
                  const active = collections.includes(c.slug)
                  return (
                    <button
                      key={c.slug}
                      type="button"
                      onClick={() => toggleCollection(c.slug)}
                      aria-pressed={active}
                      style={{
                        background: active ? "var(--rpc-red)" : "transparent",
                        border: `1px solid ${active ? "var(--rpc-red)" : "#27272a"}`,
                        color: active ? "#fff" : "rgba(255,255,255,0.75)",
                        fontFamily: condensedFont,
                        fontWeight: 800,
                        fontSize: 12,
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                        padding: "8px 12px",
                        borderRadius: 999,
                        cursor: "pointer",
                      }}
                    >
                      {c.label}
                    </button>
                  )
                })}
              </div>
              <div
                style={{
                  marginTop: 10,
                  fontSize: 10,
                  color: "rgba(255,255,255,0.4)",
                  letterSpacing: "0.04em",
                }}
              >
                {collections.length === 0
                  ? "Skip to pre-warm all five collections."
                  : `Pre-warming ${collections.length === 1 ? "this collection" : `${collections.length} collections`} only.`}
              </div>
            </div>

            {!hasIdentifier && (
              <div
                style={{
                  fontSize: 11,
                  color: "rgba(255,255,255,0.55)",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid #27272a",
                  borderRadius: 6,
                  padding: "10px 12px",
                  lineHeight: 1.55,
                }}
              >
                Add either a Flow wallet address or a username so we can pre-warm your data
                before granting access. (You only need one.)
              </div>
            )}

            {status === "error" && errorMsg && (
              <div
                style={{
                  fontSize: 12,
                  color: "#F87171",
                  background: "rgba(248,113,113,0.08)",
                  border: "1px solid rgba(248,113,113,0.3)",
                  borderRadius: 6,
                  padding: "10px 12px",
                }}
              >
                {errorMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={status === "submitting" || !!formError}
              style={{
                background: "var(--rpc-red)",
                border: "none",
                color: "#fff",
                fontFamily: condensedFont,
                fontWeight: 900,
                fontSize: 14,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                padding: 14,
                borderRadius: 6,
                cursor:
                  status === "submitting" || formError ? "not-allowed" : "pointer",
                opacity: status === "submitting" || formError ? 0.55 : 1,
              }}
            >
              {status === "submitting" ? "Submitting…" : "Request early access"}
            </button>

            <div
              style={{
                fontSize: 10,
                letterSpacing: "0.12em",
                color: "rgba(255,255,255,0.35)",
                textAlign: "center",
                textTransform: "uppercase",
              }}
            >
              No spam — only the access invite.{" "}
              <Link href="/privacy" style={{ color: "rgba(255,255,255,0.55)" }}>
                Privacy
              </Link>
            </div>
          </form>
        )}
      </div>
    </main>
  )
}

function SuccessCard({ duplicate }: { duplicate: boolean }) {
  return (
    <div
      className="bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl"
      style={{
        padding: "32px 24px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 38, marginBottom: 10 }}>{duplicate ? "👀" : "📬"}</div>
      <div
        style={{
          fontFamily: condensedFont,
          fontWeight: 900,
          fontSize: 22,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        {duplicate ? "Already on the list" : "You're on the list"}
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.65,
          color: "rgba(255,255,255,0.7)",
        }}
      >
        {duplicate
          ? "We already have your details — sit tight and we'll email you when access opens."
          : "You're on the list — we'll email you when your access is ready."}
      </div>
      <div
        style={{
          marginTop: 24,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.35)",
        }}
      >
        <Link href="/" style={{ color: "rgba(255,255,255,0.55)" }}>← Back to home</Link>
      </div>
    </div>
  )
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label style={{ display: "block" }}>
      <Label>
        {label}
        {required ? <span style={{ color: "var(--rpc-red)", marginLeft: 4 }}>*</span> : null}
      </Label>
      {children}
      {hint ? (
        <div
          style={{
            marginTop: 6,
            fontSize: 10,
            color: "rgba(255,255,255,0.4)",
            letterSpacing: "0.04em",
          }}
        >
          {hint}
        </div>
      ) : null}
    </label>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: monoFont,
        fontSize: 10,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: "rgba(255,255,255,0.5)",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#0a0a0a",
  border: "1px solid #27272a",
  borderRadius: 6,
  padding: "10px 12px",
  color: "#fff",
  fontFamily: monoFont,
  fontSize: 13,
  outline: "none",
}
