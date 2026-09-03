// app/api/profile/me/route.ts
//
// Returns the current user's identity (uuid + email + allow_list username/wallet)
// for the profile page, concierge, and the header identity widget. Returns
// { user: null } when not signed in — never 401s — so public pages can call this
// unconditionally.
//
// `display_name` is the profanity-guarded resolver chain from
// lib/user/resolveDisplayName.ts: user_profiles.display_name → profile_bio
// → allow_list.username → email-local → short wallet → "Collector".
// Use this in any UI that today greets the user by raw wallet address.

import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import { resolveDisplayName } from "@/lib/user/resolveDisplayName"

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ user: null }, {
      headers: { "Cache-Control": "no-store" },
    })
  }

  let username: string | null = null
  let walletAddr: string | null = null
  // ⚠ IDENTITY_DEGRADED — the difference between "you have no wallet on file"
  // and "we could not read whether you do". Both reads below used to swallow
  // `error`, and supabase-js RETURNS errors rather than throwing, so a failed
  // read resolved `{ data: null, error }` and this route answered 200 with
  // `wallet_addr: null` — ASSERTING an absence it had not established, about
  // the reader's OWN ACCOUNT.
  //
  // Why that is not cosmetic: this file's own note below records that
  // `wallet_addr` is what the header's Pro badge and the concierge key on. The
  // chain is useSessionOwner -> useProStatus(walletAddr) -> isPro:false, so a
  // failed read takes the PRO badge away from a paying member. And because the
  // response was a confident 200, NO consumer could tell — DashboardClient
  // carries a `meFailed` flag for exactly this and it never fired, because the
  // request had not failed.
  //
  // ⚠ Deliberately still 200 with the user object. The signed-in fact IS known
  // (getCurrentUser succeeded); only the enrichment is unknown. Returning 5xx
  // would make a signed-in reader render as ANON on every public board that
  // calls this unconditionally — trading a quiet false claim for a louder one.
  let identityDegraded = false

  // ⚠ THE PUBLIC HANDLE COMES FIRST. `profile_bio.username` is the handle the
  // collector chose (or that resolve-and-associate claimed for them) — it is the
  // `/profile/<u>` URL, and it is what ProfileClient compares against to decide
  // whether the viewer is looking at their OWN page. Until 2026-09-02 this route
  // never read it: it derived `username` from allow_list (closed-beta era) and
  // then from saved_wallets.username (the TOP SHOT name), so an address-path
  // signup — or anyone who renamed their handle in /profile/edit — answered
  // `username: null` here while `/profile/<u>` existed, and the owner-only
  // share block on their own profile never rendered (QA walkthrough, finding #2).
  //
  // ⚠ AND THE TOP SHOT NAME IS NOT A FALLBACK FOR IT (2026-09-02, second QA
  // account). Both consumers of `username` — ProfileClient's "is this MY page"
  // compare and the rewards page's share link — mean the PUBLIC HANDLE. With
  // the fallback, a collector who saved Trevor's wallet by Top Shot username
  // answered `username: "jamesdillonbond"` with no handle of their own, so
  // on /profile/jamesdillonbond they were treated as the OWNER and their share
  // link pointed at someone else's profile. The Top Shot name now travels as
  // `topshot_username`, separately; `username` is the handle or null.
  let topshotUsername: string | null = null
  {
    const { data: bio, error: bioError } = await (supabaseAdmin as any)
      .from("profile_bio")
      .select("username")
      .eq("user_id", user.id)
      .maybeSingle()
    if (bioError) {
      identityDegraded = true
      console.error(`[profile/me] profile_bio read failed: ${bioError.message ?? String(bioError)}`)
    }
    const handle = typeof bio?.username === "string" ? bio.username.trim() : ""
    if (handle) username = handle
  }

  if (user.email) {
    const { data, error } = await (supabaseAdmin as any)
      .from("allow_list")
      .select("username, wallet_addr")
      .ilike("email", user.email)
      .limit(1)
      .maybeSingle()
    if (error) {
      identityDegraded = true
      console.error(`[profile/me] allow_list read failed: ${error.message ?? String(error)}`)
    }
    topshotUsername = topshotUsername ?? data?.username ?? null
    walletAddr = data?.wallet_addr ?? null
  }

  // Fall back to a saved wallet when there is no allow_list row. The front door
  // opened 2026-07-20 (self-serve, allow-by-default), so open-door signups never
  // get an allow_list row at all — leaving wallet_addr permanently null for
  // everyone who joined after that date. That matters because this field is what
  // the header's Pro badge and the concierge key on, and it became load-bearing
  // on 2026-08-08 when the wallet-connect surfaces were removed and client code
  // stopped having fcl.currentUser to read an address from.
  if (!walletAddr) {
    const { data: saved, error: savedError } = await (supabaseAdmin as any)
      .from("saved_wallets")
      .select("wallet_addr, username")
      .eq("user_id", user.id)
      .order("pinned_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (savedError) {
      identityDegraded = true
      console.error(`[profile/me] saved_wallets read failed: ${savedError.message ?? String(savedError)}`)
    }
    walletAddr = saved?.wallet_addr ?? null
    topshotUsername = topshotUsername ?? saved?.username ?? null
  }

  const resolved = await resolveDisplayName({
    user_id: user.id,
    email: user.email ?? null,
    wallet_addr: walletAddr,
  })

  return NextResponse.json(
    {
      user: {
        id: user.id,
        email: user.email ?? null,
        created_at: user.created_at ?? null,
        username,
        // The Top Shot username the collector's wallet was saved under, when
        // any. NOT the public handle — do not compare it against /profile/<u>.
        topshot_username: topshotUsername,
        wallet_addr: walletAddr,
        display_name: resolved.display_name,
        display_name_source: resolved.source,
        // True when a lookup FAILED, so `username`/`wallet_addr` above are
        // UNKNOWN rather than known-absent. Consumers that make a claim from
        // those fields should withhold instead. (ProBadge already withholds on
        // a null wallet, which is the correct behaviour for unknown — the defect
        // was that nothing could tell the two apart, and nothing was logged.)
        identity_degraded: identityDegraded,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
