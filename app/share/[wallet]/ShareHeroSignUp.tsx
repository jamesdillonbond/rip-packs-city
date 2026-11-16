"use client"

// The account CTA under the Total FMV hero (2026-11-16). SIGNED-OUT viewers only:
// a signed-in viewer already has an account, and SaveToCollectionCTA (further down)
// is their one-click save. Renders nothing until the session is known, so a
// signed-in viewer never sees it flash.

import { useEffect, useState } from "react"
import { getSupabaseBrowser } from "@/lib/auth/supabase-client"
import ShareSignUpLink from "./ShareSignUpLink"

export default function ShareHeroSignUp({ wallet }: { wallet: string }) {
  const [anon, setAnon] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    const supabase = getSupabaseBrowser()
    supabase.auth
      .getUser()
      .then(({ data }: { data: { user: unknown } | null }) => {
        if (active) setAnon(!data?.user)
      })
      // A failed session read is not "signed out": show nothing.
      .catch(() => {
        if (active) setAnon(false)
      })
    const { data: sub } = supabase.auth.onAuthStateChange((_e: string, session: { user?: unknown } | null) => {
      if (active) setAnon(!session?.user)
    })
    return () => {
      active = false
      sub?.subscription?.unsubscribe()
    }
  }, [])

  if (anon !== true) return null
  return (
    <div
      data-rpc-share-hero-signup
      style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 12,
        margin: "-24px 0 28px", padding: "14px 16px", border: "1px solid var(--rpc-border)", borderRadius: 12,
      }}
    >
      <span style={{ fontSize: 14, color: "var(--rpc-text-secondary)", lineHeight: 1.4 }}>
        Track this collection&apos;s value on your own dashboard.
      </span>
      <ShareSignUpLink wallet={wallet} surface="share_hero" label="Save it to a free account →" />
    </div>
  )
}
