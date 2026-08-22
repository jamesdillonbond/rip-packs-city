"use client"

// components/WalletSearch.tsx
//
// THE canonical wallet-search entry point — the product's top-of-funnel wedge
// ("paste a wallet, see what you own"). Factored out of HomePageMarketing's
// private WalletSearch on 2026-07-25 so the SAME input, with the SAME funnel
// instrumentation, can live on the surfaces that actually receive traffic.
//
// Why this exists (measured 2026-07-25, funnel_events, trailing 7d):
//   collection_view 131 · insights_view 40 · home_view 20
// i.e. ~90% of tracked views never touch the marketing home — the one surface
// that had an INSTRUMENTED wallet box. Meanwhile /insights and
// /<collection>/overview each carried their own FORKED, UNINSTRUMENTED copy of
// this input, so every paste on them was invisible (wallet_paste: 24 lifetime,
// 2 in 7d, last 2026-07-20). This component collapses those forks into one.
//
// Routing rule (do not regress): an ANON visitor must land on a PUBLIC result.
//   destination="share"     -> /share/<wallet>            (Total FMV card)
//   destination="tc-report" -> /insights/tc-report?wallet= (deep public report)
// Never push an anon paste at an auth-gated route (/dashboard, /<c>/collection)
// — bouncing the #1 CTA to /login is what killed this funnel before.
//
// `variant` reproduces the two looks that already shipped, verbatim, so this is
// a PLACEMENT + INSTRUMENTATION change and not a restyle:
//   "hero"   — the marketing-home hero box (56px, r10, centered, max 640)
//   "inline" — the /insights hub box (52px, r8, left, max 560)

import { useCallback, useState, type CSSProperties, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { trackFunnelEvent } from "@/lib/track-funnel"

const FLOW_ADDRESS = /^0x[0-9a-fA-F]{16}$/

export type WalletSearchVariant = "hero" | "inline"
export type WalletSearchDestination = "share" | "tc-report"

type VariantSpec = {
  height: number
  radius: number
  fontSize: number
  inputLetterSpacing: string
  background: string
  maxWidth: number
  marginInline: string | undefined
  buttonLetterSpacing: string
  errorFontSize: number
  textAlign: "center" | "left"
}

// Both specs are lifted 1:1 from the two implementations that were live before
// this component existed. Changing them is a visual change — do it deliberately.
const VARIANTS: Record<WalletSearchVariant, VariantSpec> = {
  hero: {
    height: 56,
    radius: 10,
    fontSize: 15,
    inputLetterSpacing: "0.02em",
    background: "var(--rpc-surface-raised)",
    maxWidth: 640,
    marginInline: "auto",
    buttonLetterSpacing: "0.14em",
    errorFontSize: 11,
    textAlign: "center",
  },
  inline: {
    height: 52,
    radius: 8,
    fontSize: 14,
    inputLetterSpacing: "normal",
    background: "var(--rpc-surface)",
    maxWidth: 560,
    marginInline: undefined,
    buttonLetterSpacing: "0.12em",
    errorFontSize: 12,
    textAlign: "left",
  },
}

const SCOPED_CSS = `
.rpc-wallet-search input::placeholder{color:var(--rpc-text-ghost);}
.rpc-wallet-search-go{transition:background 120ms ease;}
.rpc-wallet-search-go:hover:not(:disabled){background:var(--rpc-red-hover);}
`

export default function WalletSearch({
  surface,
  variant = "hero",
  destination = "share",
  placeholder = "Top Shot username, 0x wallet, or moment ID",
  ariaLabel = "Search Top Shot username, Flow wallet, or moment ID",
  submitLabel = "ANALYZE →",
  pendingLabel = "ANALYZING…",
  hint = null,
  style,
  className,
  onSubmitValue,
}: {
  /**
   * funnel_events.surface for the wallet_paste this box emits. Use a DISTINCT
   * value per placement ("home", "insights_hub", "collection_overview", …) so
   * lift is attributable per surface. Never rename event_type — surface is the
   * axis that can grow without breaking historical comparisons.
   */
  surface: string
  variant?: WalletSearchVariant
  destination?: WalletSearchDestination
  placeholder?: string
  ariaLabel?: string
  submitLabel?: string
  pendingLabel?: string
  hint?: ReactNode
  /** Wrapper overrides (spacing only — the box itself is variant-owned). */
  style?: CSSProperties
  /**
   * Class on the WRAPPER div. Exists so a caller whose sizing must change at a
   * breakpoint can express it in CSS instead of inline style: an inline `flex`
   * cannot be overridden by a media query, which is how the collection/insights
   * band shipped a 300px flex-BASIS that became a 300px HEIGHT the moment its
   * container flipped to `flex-direction: column` on mobile. Sizing that is
   * constant at every width still belongs in `style`.
   */
  className?: string
  /**
   * Side effect fired with the raw input just before navigation (e.g. the
   * collection overview stashes rpc_last_wallet so the in-app tabs hydrate).
   * Must not throw — it is called inside the submit path.
   */
  onSubmitValue?: (raw: string) => void
}) {
  const router = useRouter()
  const [value, setValue] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const v = VARIANTS[variant]

  const go = useCallback(
    (addr: string) => {
      const enc = encodeURIComponent(addr)
      router.push(
        destination === "tc-report" ? `/insights/tc-report?wallet=${enc}` : `/share/${enc}`
      )
    },
    [router, destination]
  )

  const submit = useCallback(async () => {
    const raw = value.trim()
    if (!raw || pending) return

    // Funnel: a visitor used the wallet box. Fire-and-forget; the raw input
    // doubles as wallet_address (clamped server-side) so pastes reconcile
    // against the resulting share_view / tc-report downstream.
    trackFunnelEvent({ eventType: "wallet_paste", walletAddress: raw, surface })

    try {
      onSubmitValue?.(raw)
    } catch {
      // A caller's localStorage write must never block the navigation.
    }

    setError(null)
    if (FLOW_ADDRESS.test(raw)) {
      go(raw)
      return
    }
    setPending(true)
    try {
      const res = await fetch("/api/wallet-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: raw, limit: 1 }),
      })
      // ⚠ No status check previously. On a non-2xx the envelope still parses,
      // `walletAddress` is absent, and control fell through to the not-found
      // copy below — which tells the reader their wallet does not exist AND
      // advises them to change what they typed, out of an outage. That is the
      // "diagnoses a cause it cannot know" shape.
      if (!res.ok) {
        setError("Couldn't search just now — this says nothing about that wallet. Try again shortly.")
        return
      }
      const data = await res.json().catch(() => null)
      const addr: string | undefined = data?.walletAddress
      if (addr && FLOW_ADDRESS.test(addr)) {
        go(addr)
        return
      }
      setError(
        data?.error || "Couldn't find that username. Try a Flow wallet address (0x…)."
      )
    } catch {
      setError("Something went wrong resolving that. Try again in a moment.")
    } finally {
      setPending(false)
    }
  }, [value, pending, surface, onSubmitValue, go])

  return (
    <div
      className={className}
      style={{ width: "100%", maxWidth: v.maxWidth, marginInline: v.marginInline, ...style }}
    >
      <style>{SCOPED_CSS}</style>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="rpc-wallet-search"
        style={{
          display: "flex",
          alignItems: "stretch",
          background: v.background,
          border: "1px solid var(--rpc-border)",
          borderRadius: v.radius,
          overflow: "hidden",
          height: v.height,
        }}
      >
        <input
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "0 16px",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--rpc-text-primary)",
            fontFamily: "var(--font-mono)",
            fontSize: v.fontSize,
            letterSpacing: v.inputLetterSpacing,
          }}
        />
        <button
          type="submit"
          disabled={pending}
          className="rpc-wallet-search-go"
          style={{
            background: "var(--rpc-red)",
            border: "none",
            // brand-exception: white label on the red CTA — theme-independent
            color: "#fff",
            padding: "0 22px",
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: v.buttonLetterSpacing,
            textTransform: "uppercase",
            cursor: pending ? "wait" : "pointer",
            opacity: pending ? 0.7 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {pending ? pendingLabel : submitLabel}
        </button>
      </form>
      {error ? (
        <div
          role="alert"
          style={{
            marginTop: 10,
            fontFamily: "var(--font-mono)",
            fontSize: v.errorFontSize,
            color: "var(--rpc-red)",
            letterSpacing: "0.04em",
            textAlign: v.textAlign,
          }}
        >
          {error}
        </div>
      ) : hint ? (
        <div
          style={{
            marginTop: 10,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--rpc-text-muted)",
            letterSpacing: "0.04em",
            textAlign: v.textAlign,
          }}
        >
          {hint}
        </div>
      ) : null}
    </div>
  )
}
