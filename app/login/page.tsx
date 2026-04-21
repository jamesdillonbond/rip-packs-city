// app/login/page.tsx
//
// Email magic-link sign-in page. Primary entry to any collection tool.
//
// Flow:
//   1. User enters email → supabase.auth.signInWithOtp
//   2. Supabase emails a magic link
//   3. Link redirects to /api/auth/callback which sets cookies + redirects
//      back to the page the user was trying to visit.

"use client"

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { sendMagicLink } from "@/lib/auth/supabase-client"

function LoginInner() {
  const params = useSearchParams()
  const redirect = params.get("redirect") ?? "/profile"
  const urlError = params.get("error")
  const [email, setEmail] = useState("")
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle")
  const [error, setError] = useState(urlError ?? "")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setStatus("sending")
    setError("")
    const { error } = await sendMagicLink(email.trim().toLowerCase(), redirect)
    if (error) { setError(error); setStatus("error"); return }
    setStatus("sent")
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--rpc-black)",
      color: "var(--rpc-text-primary)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px 20px",
      fontFamily: "var(--font-body)",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=Share+Tech+Mono&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        input::placeholder{color:rgba(255,255,255,0.28);}
      `}</style>

      <div className="rpc-live-pill" style={{ marginBottom: 24 }}>RIP PACKS CITY · SIGN IN</div>

      <div className="rpc-card-neon rpc-scan-crt" style={{
        maxWidth: 440, width: "100%",
        padding: "32px 28px",
        textAlign: "center",
      }}>
        <div style={{ marginBottom: 22 }}>
          <div style={{
            fontFamily: "var(--font-display)", fontWeight: 900,
            fontSize: 28, letterSpacing: "0.04em",
            textTransform: "uppercase", lineHeight: 1,
            textShadow: "var(--neon-text-glow)",
          }}>
            Rip Packs <span style={{ color: "var(--por-red)" }}>City</span>
          </div>
          <div style={{
            fontSize: 10, fontFamily: "var(--font-mono)",
            color: "var(--rpc-text-ghost)", letterSpacing: "0.2em",
            marginTop: 6, textTransform: "uppercase",
          }}>
            Collector Intelligence {"·"} Flow Blockchain
          </div>
        </div>

        {status === "sent" ? (
          <div style={{ padding: "24px 8px" }}>
            <div style={{ fontSize: 36, marginBottom: 14 }}>{"✉️"}</div>
            <div style={{
              fontFamily: "var(--font-display)", fontWeight: 800,
              fontSize: 18, textTransform: "uppercase", letterSpacing: "0.04em",
              marginBottom: 8,
            }}>Check your email</div>
            <div style={{
              fontFamily: "var(--font-mono)", fontSize: 11,
              color: "var(--rpc-text-secondary)", lineHeight: 1.7,
            }}>
              We sent a magic link to <span style={{ color: "var(--rpc-text-primary)" }}>{email}</span>.
              <br />
              Click it to sign in. The link expires in 1 hour.
            </div>
            <button
              onClick={() => { setStatus("idle"); setEmail("") }}
              style={{
                marginTop: 22, background: "transparent",
                border: "1px solid var(--rpc-border)",
                color: "var(--rpc-text-muted)",
                padding: "8px 18px", fontFamily: "var(--font-mono)",
                fontSize: 10, letterSpacing: "0.15em", cursor: "pointer",
                borderRadius: "var(--radius-sm)", textTransform: "uppercase",
              }}>
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <label style={{
              display: "block",
              fontFamily: "var(--font-mono)", fontSize: 10,
              color: "var(--rpc-text-muted)",
              letterSpacing: "0.15em", textTransform: "uppercase",
              marginBottom: 8, textAlign: "left",
            }}>
              Email address
            </label>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={status === "sending"}
              style={{
                width: "100%",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid var(--rpc-red-border)",
                color: "var(--rpc-text-primary)",
                fontFamily: "var(--font-mono)",
                fontSize: 14, padding: "12px 14px",
                borderRadius: "var(--radius-sm)",
                outline: "none",
                marginBottom: 16,
              }}
            />

            <button
              type="submit"
              disabled={status === "sending" || !email.trim()}
              style={{
                width: "100%",
                background: "var(--por-red)",
                border: "none", color: "var(--por-white)",
                fontFamily: "var(--font-display)", fontWeight: 900,
                fontSize: 14, letterSpacing: "0.12em", textTransform: "uppercase",
                padding: "14px",
                borderRadius: "var(--radius-sm)",
                cursor: status === "sending" ? "wait" : "pointer",
                opacity: !email.trim() ? 0.5 : 1,
                boxShadow: "var(--scan-glow)",
                transition: "box-shadow 0.2s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.boxShadow = "var(--scan-glow-strong)")}
              onMouseLeave={(e) => (e.currentTarget.style.boxShadow = "var(--scan-glow)")}
            >
              {status === "sending" ? "Sending link…" : "Send magic link"}
            </button>

            {error && (
              <div style={{
                marginTop: 14,
                padding: "10px 12px",
                background: "rgba(248,113,113,0.08)",
                border: "1px solid rgba(248,113,113,0.3)",
                borderRadius: "var(--radius-sm)",
                fontFamily: "var(--font-mono)",
                fontSize: 11, color: "var(--rpc-danger)",
              }}>
                {error}
              </div>
            )}
          </form>
        )}

        <div style={{
          marginTop: 28, paddingTop: 18,
          borderTop: "1px solid var(--rpc-border)",
          fontFamily: "var(--font-mono)", fontSize: 9,
          color: "var(--rpc-text-ghost)",
          letterSpacing: "0.15em", textTransform: "uppercase",
          lineHeight: 1.8,
        }}>
          No password {"·"} Magic-link only
          <br />
          <Link href="/privacy" style={{ color: "var(--rpc-text-muted)", textDecoration: "none" }}>Privacy</Link>
          {" · "}
          <Link href="/terms" style={{ color: "var(--rpc-text-muted)", textDecoration: "none" }}>Terms</Link>
        </div>
      </div>

      <div style={{
        marginTop: 28, fontFamily: "var(--font-mono)",
        fontSize: 10, color: "var(--rpc-text-ghost)",
        letterSpacing: "0.15em",
      }}>
        {"⚡ NBA TOP SHOT · NFL ALL DAY · LALIGA GOLAZOS · DISNEY PINNACLE"}
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#080808" }} />}>
      <LoginInner />
    </Suspense>
  )
}
