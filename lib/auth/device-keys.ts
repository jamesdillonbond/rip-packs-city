// lib/auth/device-keys.ts
//
// Per-DEVICE wallet state that the collection pages hydrate from — owner key,
// last wallet, owned-moment caches, the first-run flag — is keyed by ORIGIN,
// not by user. A second account signing in on the same browser therefore
// starts with the previous collector's wallet (measured 2026-09-02: a
// brand-new account preloaded 15,160 Moments of someone else's wallet before
// it had added one). Server reads are guarded either way; this is about not
// doing the wrong work, and not showing the wrong collection for a beat.
//
// ⚠ Called from the DASHBOARD (the first signed-in surface every sign-in path
// reaches), not only from /auth/confirm: the branded token-hash magic link
// lands on the server route /api/auth/callback and redirects straight to
// /dashboard, so a clear that lived only in AuthConfirmClient never ran for
// it (seen live 2026-09-02 on the second QA account).

const SESSION_USER_KEY = "rpc_session_user"

const EXACT_KEYS = [
  "rpc_owner_key",
  "rpc_last_wallet",
  "rpc_wallet_address",
  "rpc_last_hydrated",
  "rpc:first-run-completed",
]

const PREFIXES = ["rpc_owned_"]

/**
 * Record `uid` as the account this browser is signed in as. When it differs
 * from the previous one, drop the previous account's per-device wallet keys.
 * Returns the number of keys removed (0 when the account is unchanged or
 * this is the first sign-in on the device). Never throws.
 */
export function reconcileDeviceKeysForUser(uid: string | null | undefined): number {
  if (!uid || typeof window === "undefined") return 0
  try {
    const ls = window.localStorage
    const previous = ls.getItem(SESSION_USER_KEY)
    let removed = 0
    if (previous && previous !== uid) {
      const doomed: string[] = []
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i)
        if (!k) continue
        if (EXACT_KEYS.includes(k) || PREFIXES.some((p) => k.startsWith(p))) doomed.push(k)
      }
      doomed.forEach((k) => ls.removeItem(k))
      removed = doomed.length
    }
    ls.setItem(SESSION_USER_KEY, uid)
    return removed
  } catch {
    // private mode / storage blocked — nothing to clear
    return 0
  }
}
