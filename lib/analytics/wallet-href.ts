// Where a wallet name or address links to, by who is looking (2026-10-25).
//
// /analytics/** is a SIGN-IN area (proxy.ts; the 10-11 platform review M7 took its
// nav link away from signed-out readers rather than leave "a visible link that 307s
// on click — the same dead end one step later"). Public pages still linked wallet
// names into it — the per-collection Analytics tab's tables, Top Buyers, the moment
// modal's "Defaulted by", the pack page's buyer/seller cells — so a signed-out reader
// who clicked a wallet landed on the login page. Measured 2026-10-25 by a signed-out
// mobile walk of production.
//
// A signed-in reader keeps the full wallet profile; everyone else gets the public
// wallet page, /share/<wallet>, which reads the same public holdings.

export const WALLET_PROFILE_PREFIX = "/analytics/wallets/"
export const PUBLIC_WALLET_PREFIX = "/share/"

/** The wallet page this reader can open. `signedIn` unknown (loading) → the public page. */
export function walletProfileHref(address: string, signedIn: boolean): string {
  const a = encodeURIComponent(address)
  return signedIn ? `${WALLET_PROFILE_PREFIX}${a}` : `${PUBLIC_WALLET_PREFIX}${a}`
}
