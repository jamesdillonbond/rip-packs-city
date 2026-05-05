"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

const DISMISS_KEY = "rpc_welcome_dismissed_v1"

interface WelcomeModalProps {
  accent: string
  collectionId: string
}

export default function WelcomeModal({ accent, collectionId }: WelcomeModalProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [walletInput, setWalletInput] = useState("")
  const [showWhatIs, setShowWhatIs] = useState(false)

  useEffect(() => {
    try {
      if (window.localStorage.getItem(DISMISS_KEY) !== "1") setOpen(true)
    } catch {
      // localStorage unavailable (private mode etc.) — leave closed.
    }
  }, [])

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1")
    } catch { /* ignore */ }
    setOpen(false)
  }

  function lookupWallet(e: React.FormEvent) {
    e.preventDefault()
    const q = walletInput.trim()
    if (!q) return
    dismiss()
    router.push(`/${collectionId}/collection?q=${encodeURIComponent(q)}`)
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Rip Packs City"
      onClick={dismiss}
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/85 backdrop-blur-md"
      style={{ animation: "fadeIn 220ms ease-out" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl"
        style={{
          width: "min(90vw, 480px)",
          padding: "28px 24px 22px",
          animation: "fadeIn 280ms ease-out",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 18,
          }}
        >
          <span
            style={{
              fontSize: 9,
              fontFamily: "'Share Tech Mono', monospace",
              color: accent,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
            }}
          >
            Step {step} of 3
          </span>
          <button
            onClick={dismiss}
            aria-label="Dismiss welcome"
            style={{
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.4)",
              fontSize: 18,
              cursor: "pointer",
              lineHeight: 1,
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        {step === 1 && (
          <Step1
            accent={accent}
            showWhatIs={showWhatIs}
            onToggleWhatIs={() => setShowWhatIs((v) => !v)}
          />
        )}
        {step === 2 && (
          <Step2
            accent={accent}
            collectionId={collectionId}
            walletInput={walletInput}
            onWalletInput={setWalletInput}
            onSubmitWallet={lookupWallet}
            onDismiss={dismiss}
          />
        )}
        {step === 3 && <Step3 accent={accent} />}

        <div
          style={{
            marginTop: 22,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          {step > 1 ? (
            <button
              onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
              style={btnGhost()}
            >
              Back
            </button>
          ) : (
            <button onClick={dismiss} style={btnGhost()}>
              Maybe later
            </button>
          )}

          {step < 3 ? (
            <button onClick={() => setStep((s) => (s === 1 ? 2 : 3))} style={btnPrimary(accent)}>
              Next
            </button>
          ) : (
            <Link href="/login" onClick={dismiss} style={{ ...btnPrimary(accent), textDecoration: "none" }}>
              Sign in
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

function Step1({
  accent,
  showWhatIs,
  onToggleWhatIs,
}: {
  accent: string
  showWhatIs: boolean
  onToggleWhatIs: () => void
}) {
  return (
    <div>
      <h2
        style={{
          margin: 0,
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 900,
          fontSize: 26,
          letterSpacing: "0.04em",
          color: "#fff",
          textTransform: "uppercase",
          lineHeight: 1.1,
        }}
      >
        Welcome to Rip Packs City
      </h2>
      <p
        style={{
          marginTop: 14,
          fontFamily: "'Share Tech Mono', monospace",
          fontSize: 12,
          color: "rgba(255,255,255,0.7)",
          lineHeight: 1.65,
        }}
      >
        Flow blockchain collector intelligence for NBA Top Shot, NFL All Day, LaLiga
        Golazos, Disney Pinnacle, and UFC Strike.
      </p>
      <button
        onClick={onToggleWhatIs}
        style={{
          marginTop: 14,
          background: "transparent",
          border: `1px solid ${accent}55`,
          color: accent,
          padding: "6px 12px",
          borderRadius: 4,
          fontFamily: "'Share Tech Mono', monospace",
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        {showWhatIs ? "Hide" : "What is RPC?"}
      </button>
      {showWhatIs && (
        <p
          style={{
            marginTop: 12,
            fontFamily: "'Share Tech Mono', monospace",
            fontSize: 11,
            color: "rgba(255,255,255,0.55)",
            lineHeight: 1.6,
          }}
        >
          RPC bundles wallet analytics, FMV pricing, deal-finding, set-completion
          tracking, and pack EV — pulling live data from Flow, Flowty, and the native
          marketplaces. Built by a Portland Trail Blazers Team Captain on Top Shot.
        </p>
      )}
    </div>
  )
}

function Step2({
  accent,
  collectionId,
  walletInput,
  onWalletInput,
  onSubmitWallet,
  onDismiss,
}: {
  accent: string
  collectionId: string
  walletInput: string
  onWalletInput: (v: string) => void
  onSubmitWallet: (e: React.FormEvent) => void
  onDismiss: () => void
}) {
  return (
    <div>
      <h2
        style={{
          margin: 0,
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 900,
          fontSize: 22,
          letterSpacing: "0.04em",
          color: "#fff",
          textTransform: "uppercase",
          lineHeight: 1.1,
        }}
      >
        Three things you can do right now
      </h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
        <Link
          href={`/${collectionId}/sniper`}
          onClick={onDismiss}
          style={cardStyle(accent)}
        >
          <div style={cardLabel(accent)}>Browse the Sniper</div>
          <div style={cardBody()}>Live deals listed below FMV across the marketplace.</div>
        </Link>

        <form onSubmit={onSubmitWallet} style={{ ...cardStyle(accent), cursor: "default" }}>
          <div style={cardLabel(accent)}>Look up any wallet</div>
          <div style={cardBody()}>See a collector's full FMV-priced collection.</div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input
              value={walletInput}
              onChange={(e) => onWalletInput(e.target.value)}
              placeholder="0x… or username"
              style={{
                flex: 1,
                background: "#0a0a0a",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 4,
                padding: "6px 10px",
                color: "#fff",
                fontFamily: "'Share Tech Mono', monospace",
                fontSize: 11,
                outline: "none",
              }}
            />
            <button type="submit" style={btnPrimary(accent, true)}>
              Go
            </button>
          </div>
        </form>

        <Link
          href={`/${collectionId}/packs`}
          onClick={onDismiss}
          style={cardStyle(accent)}
        >
          <div style={cardLabel(accent)}>See pack EV</div>
          <div style={cardBody()}>Find drops where expected value beats retail.</div>
        </Link>
      </div>
    </div>
  )
}

function Step3({ accent }: { accent: string }) {
  return (
    <div>
      <h2
        style={{
          margin: 0,
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 900,
          fontSize: 24,
          letterSpacing: "0.04em",
          color: "#fff",
          textTransform: "uppercase",
          lineHeight: 1.1,
        }}
      >
        Save your spot
      </h2>
      <p
        style={{
          marginTop: 14,
          fontFamily: "'Share Tech Mono', monospace",
          fontSize: 12,
          color: "rgba(255,255,255,0.7)",
          lineHeight: 1.65,
        }}
      >
        Sign in via email magic-link to save wallets, build a public profile, and pin
        moments to your trophy case.
      </p>
      <div
        style={{
          marginTop: 14,
          padding: "10px 12px",
          background: `${accent}10`,
          border: `1px solid ${accent}33`,
          borderRadius: 6,
          fontFamily: "'Share Tech Mono', monospace",
          fontSize: 10,
          color: "rgba(255,255,255,0.55)",
          letterSpacing: "0.04em",
          lineHeight: 1.6,
        }}
      >
        No password — we send you a one-time link. Browsing stays free even if you
        skip sign-in.
      </div>
    </div>
  )
}

// ── Style helpers (kept inline so the component is self-contained) ──
function cardStyle(accent: string): React.CSSProperties {
  return {
    display: "block",
    padding: "10px 12px",
    background: "rgba(255,255,255,0.03)",
    border: `1px solid ${accent}33`,
    borderRadius: 6,
    textDecoration: "none",
    color: "#fff",
    cursor: "pointer",
  }
}
function cardLabel(accent: string): React.CSSProperties {
  return {
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 700,
    fontSize: 13,
    letterSpacing: "0.06em",
    color: accent,
    textTransform: "uppercase",
    marginBottom: 4,
  }
}
function cardBody(): React.CSSProperties {
  return {
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 11,
    color: "rgba(255,255,255,0.6)",
    lineHeight: 1.55,
  }
}
function btnGhost(): React.CSSProperties {
  return {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.18)",
    color: "rgba(255,255,255,0.7)",
    padding: "8px 16px",
    borderRadius: 5,
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: 10,
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    cursor: "pointer",
  }
}
function btnPrimary(accent: string, small = false): React.CSSProperties {
  return {
    background: accent,
    border: "none",
    color: "#fff",
    padding: small ? "6px 12px" : "9px 18px",
    borderRadius: 5,
    fontFamily: "'Barlow Condensed', sans-serif",
    fontWeight: 800,
    fontSize: small ? 11 : 13,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    cursor: "pointer",
    display: "inline-block",
  }
}
