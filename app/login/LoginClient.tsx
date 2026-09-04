// app/login/LoginClient.tsx
//
// Email magic-link sign-in / sign-up page. Primary entry to any collection tool.
//
// Self-serve signup is OPEN (2026-07-20): any email gets a magic link.
//   1. User enters email
//   2. Page POSTs to /api/auth/request-magic-link (server-side gate)
//   3. The gate (check_email_allowed) is allow-by-default — it returns 403 ONLY
//      for an explicitly revoked / deny-listed email. A brand-new email always
//      passes, so the 403 "blocked" branch below is now a genuine access block,
//      not a closed-beta waitlist.
//   4. Otherwise Supabase emails the magic link (shouldCreateUser: true, so a
//      first-time email creates the account) and the link redirects to
//      /auth/confirm which sets cookies + bounces back to ?redirect=.

"use client"

import { useState } from "react"
import { loginErrorCopy } from "@/lib/auth/login-error-copy"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { sendMagicLink } from "@/lib/auth/supabase-client"

type Status = "idle" | "sending" | "sent" | "error" | "waitlist"

export default function LoginClient() {
  const params = useSearchParams()
  // `next` is what proxy.ts (root middleware) emits; `redirect` is the legacy
  // param name used by older links and by the magic-link callback chain.
  const redirect = params.get("next") ?? params.get("redirect") ?? "/dashboard"
  const urlErrorRaw = params.get("error")
  // `access_revoked` is the canonical signal from proxy.ts when the auth gate
  // bounces a signed-in but non-allow-listed user. We render a dedicated
  // banner above the form for it (not the inline submit-error div) so the
  // closed-beta messaging stays visible even after the user resubmits with a
  // different email.
  const isClosedBetaBlock = urlErrorRaw === "access_revoked"
  // ⚠ MAPPED, NEVER ECHOED. This used to fall through to `urlErrorRaw` for any
  // value it did not recognise, so (a) real slugs like "session_failed" were
  // shown to people, and (b) — the one that matters — ANY text in the query
  // string rendered inside our own error banner, in our voice, on the login
  // page. A crafted link was a phishing message wearing our UI. See
  // lib/auth/login-error-copy.ts.
  const urlError = loginErrorCopy(urlErrorRaw)
  const [email, setEmail] = useState("")
  const [status, setStatus] = useState<Status>("idle")
  const [error, setError] = useState(urlError ?? "")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setStatus("sending")
    setError("")
    const result = await sendMagicLink(email.trim().toLowerCase(), redirect)
    if (result.ok) {
      setStatus("sent")
      return
    }
    if (result.notOnAllowList) {
      setStatus("waitlist")
      return
    }
    setError(result.error)
    setStatus("error")
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
        ) : status === "waitlist" ? (
          <div style={{ padding: "24px 8px" }}>
            <div style={{ fontSize: 36, marginBottom: 14 }}>{"🚫"}</div>
            <div style={{
              fontFamily: "var(--font-display)", fontWeight: 800,
              fontSize: 18, textTransform: "uppercase", letterSpacing: "0.04em",
              marginBottom: 10,
            }}>
              Can&apos;t sign in with that email
            </div>
            <div style={{
              fontFamily: "var(--font-mono)", fontSize: 11,
              color: "var(--rpc-text-secondary)", lineHeight: 1.7,
            }}>
              We couldn&apos;t send a magic link to{" "}
              <span style={{ color: "var(--rpc-text-primary)" }}>{email}</span>. If you think
              this is a mistake, reach out on{" "}
              <a
                href="https://twitter.com/RipPacksCity"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--rpc-text-primary)", textDecoration: "underline" }}
              >
                X (@RipPacksCity)
              </a>{" "}
              and we&apos;ll sort it out.
            </div>
            <div style={{ marginTop: 22 }}>
              <button
                onClick={() => { setStatus("idle"); setEmail("") }}
                style={{
                  background: "var(--por-red)",
                  border: "none", color: "var(--por-white)",
                  padding: "12px 22px", fontFamily: "var(--font-display)",
                  fontWeight: 900, fontSize: 13, letterSpacing: "0.12em",
                  cursor: "pointer", borderRadius: "var(--radius-sm)",
                  textTransform: "uppercase", boxShadow: "var(--scan-glow)",
                }}>
                Try a different email
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {isClosedBetaBlock && (
              <div style={{
                marginBottom: 18,
                padding: "14px 16px",
                background: "var(--rpc-red-bg)",
                border: "1px solid var(--rpc-red)",
                borderRadius: "var(--radius-sm)",
                textAlign: "left",
              }}>
                <div style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 800,
                  fontSize: 13,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--rpc-red)",
                  marginBottom: 6,
                }}>
                  Access unavailable
                </div>
                <div style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: "var(--rpc-text-secondary)",
                }}>
                  This account&apos;s access has been removed. If you think this is a
                  mistake, reach out on
                  {" "}
                  <a
                    href="https://twitter.com/RipPacksCity"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--rpc-text-primary)", textDecoration: "underline" }}
                  >
                    X (@RipPacksCity)
                  </a>
                  {" "}and we&apos;ll take a look.
                </div>
              </div>
            )}
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
                {String(error).trim() || "Something went wrong — please try again."}
              </div>
            )}

            <div style={{
              marginTop: 18,
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--rpc-text-ghost)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}>
              New here? A free account is instant, no invite needed — track your wallets across every Flow collection, then pin your 6 best Moments to a trophy case you can share.{" "}
              <Link href="/insights" style={{ color: "var(--rpc-text-muted)" }}>
                Or browse without an account →
              </Link>
            </div>
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
          {/* 2026-09-04: 10px text on a 44x10 box is not a tap target on a phone —
              the links get an inline-block hit area of their own. */}
          <Link href="/privacy" style={{ color: "var(--rpc-text-muted)", textDecoration: "none", fontSize: 11, display: "inline-block", padding: "10px 6px" }}>Privacy</Link>
          {"·"}
          <Link href="/terms" style={{ color: "var(--rpc-text-muted)", textDecoration: "none", fontSize: 11, display: "inline-block", padding: "10px 6px" }}>Terms</Link>
        </div>
      </div>

      <Link
        href="/insights"
        style={{
          marginTop: 22,
          display: "inline-block",
          maxWidth: 440,
          width: "100%",
          textAlign: "center",
          padding: "12px 18px",
          background: "rgba(224,58,47,0.08)",
          border: "1px solid var(--rpc-red-border)",
          borderRadius: "var(--radius-sm)",
          color: "var(--rpc-text-primary)",
          textDecoration: "none",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.06em",
          lineHeight: 1.5,
        }}
      >
        Explore the public Squeeze Board &amp; insights —{" "}
        <span style={{ color: "var(--por-red)", whiteSpace: "nowrap" }}>no account needed →</span>
      </Link>

      <div style={{
        marginTop: 24, fontFamily: "var(--font-mono)",
        fontSize: 10, color: "var(--rpc-text-ghost)",
        letterSpacing: "0.15em",
      }}>
        {"⚡ NBA TOP SHOT · NFL ALL DAY · LALIGA GOLAZOS · DISNEY PINNACLE · UFC STRIKE"}
      </div>
    </div>
  )
}
