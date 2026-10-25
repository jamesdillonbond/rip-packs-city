'use client'

// Whether the reader has a session — for choosing which LINK to show (2026-10-25,
// lib/analytics/wallet-href.ts). DISPLAY STATE ONLY: the server gates every
// capability; this only decides whether a link would land on the login page.
//
// One local session read per page load, shared by every caller (module-level
// promise), so a page with several wallet tables does not fan out requests.
// Until it resolves the answer is `false`, which picks the public destination —
// the safe side: a signed-in reader briefly sees a public link, a signed-out
// reader never sees one that bounces.

import { useEffect, useState } from 'react'
import { getSupabaseBrowser } from '@/lib/auth/supabase-client'

let cached: Promise<boolean> | null = null

function readSignedIn(): Promise<boolean> {
  if (!cached) {
    cached = Promise.resolve()
      .then(() => getSupabaseBrowser().auth.getSession())
      .then(({ data }: { data: { session: { user?: unknown } | null } | null }) => !!data?.session?.user)
      .catch(() => false)
  }
  return cached
}

/** Test seam: forget the cached answer. */
export function __resetIsSignedInCache(): void {
  cached = null
}

export function useIsSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => {
    let active = true
    readSignedIn().then((v) => { if (active) setSignedIn(v) })
    return () => { active = false }
  }, [])
  return signedIn
}
