"use client"

// components/auth/AccountCta.tsx
//
// The signed-out header controls, ONE component for every header (2026-11-07).
//
// Trevor: "There's no easy way to identify how to create an account front and
// center when a new user hits the main Rippackscity.com page when not logged in."
// Every header carried a single dim "SIGN IN" pill — the word a RETURNING user
// looks for, and nothing that says an account can be made. Sign-in and sign-up
// are the same magic link (/login, `shouldCreateUser: true`), so the fix is
// wording and emphasis, not a second flow: the primary pill says CREATE FREE
// ACCOUNT and lands on /login?intent=signup (which heads the page as account
// creation); "Sign in" sits beside it as plain text for the returning user.
//
// `next` returns the visitor to the page they were reading after the link.

import Link from "next/link"
import { usePathname } from "next/navigation"
import { trackFunnelEvent } from "@/lib/track-funnel"

export function signupHref(pathname: string | null | undefined): string {
  const onAuthPage = !pathname || pathname === "/login" || pathname.startsWith("/auth/")
  const next = onAuthPage || pathname === "/" ? "" : `&next=${encodeURIComponent(pathname)}`
  return `/login?intent=signup${next}`
}

export function signinHref(pathname: string | null | undefined): string {
  const onAuthPage = !pathname || pathname === "/login" || pathname.startsWith("/auth/")
  const next = onAuthPage || pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`
  return `/login${next}`
}

export default function AccountCta(props: {
  /** Funnel surface name, e.g. "home_header" or "site_header". */
  surface: string
  /** Larger pill for the landing header. */
  size?: "sm" | "md"
}) {
  const pathname = usePathname()
  const md = props.size === "md"
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: md ? 12 : 8, flexShrink: 0 }}>
      <Link
        href={signinHref(pathname)}
        onClick={() => trackFunnelEvent({ eventType: "signin_click", surface: props.surface })}
        className="rpc-tap44 rpc-account-cta-signin"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: md ? 11 : 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--rpc-text-secondary)",
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        Sign in
      </Link>
      <Link
        href={signupHref(pathname)}
        // `signin_click` is the DB-checked event type (funnel_events CHECK); the
        // surface suffix tells the two pills apart without a new type.
        onClick={() => trackFunnelEvent({ eventType: "signin_click", surface: `${props.surface}_signup` })}
        className="rpc-tap44"
        style={{
          background: "var(--rpc-red-fill)",
          border: "1px solid var(--rpc-red-border)",
          // brand-exception: white text on the --rpc-red button
          color: "#fff",
          padding: md ? "7px 14px" : "5px 10px",
          borderRadius: 4,
          fontSize: md ? 11 : 10,
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          textDecoration: "none",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        Create free account
      </Link>
      {/* The "Sign in" text yields first on a narrow phone header; the pill lands on
          the same form, which signs a returning user in too. */}
      <style>{`@media (max-width: 400px){ .rpc-account-cta-signin{ display:none; } }`}</style>
    </span>
  )
}
