// lib/share-link.ts
//
// The anonymous collection-card share (/share/<wallet>) — one URL builder and
// one share action, used by the card page's own button and by the collection
// tab's post-search "Share" button.
//
// Why (2026-10-03): both buttons copied a BARE URL (the card page even copied
// `window.location.href`, which re-shares whatever utm the copier arrived
// with). The profile share path has tagged its links since July
// (ShareProfileButtons: utm_source=share&utm_medium=<x|copy>), and
// lib/track-funnel.ts already records an arrival's utm on every funnel event of
// that session — so a visit from a shared CARD was the one share arrival that
// could not be told apart from direct traffic. Tagging it here closes that
// without a new event type or a funnel_events CHECK change.
//
// Same vocabulary as the profile path: utm_source=share, utm_medium = the
// channel. "native" = the OS share sheet (mobile), "copy" = clipboard.
//
// ⚠ The wallet is encoded, never case-folded: a Solana key is case-sensitive
// (CLAUDE.md, chain two), and the card route resolves it verbatim.

export type ShareMedium = "copy" | "native"

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed"

const CANONICAL_ORIGIN = "https://www.rippackscity.com"

export function walletShareUrl(
  wallet: string,
  medium: ShareMedium,
  origin: string = CANONICAL_ORIGIN,
): string {
  return `${origin}/share/${encodeURIComponent(wallet.trim())}?utm_source=share&utm_medium=${medium}`
}

// The OS share sheet only where it is the natural gesture. Desktop Chrome and
// Edge on Windows expose navigator.share too, and swapping a desktop user's
// "copy link" for a Windows share dialog would be a regression, so gate on a
// coarse (touch) primary pointer as well.
export function canNativeShare(): boolean {
  try {
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
    return window.matchMedia("(pointer: coarse)").matches
  } catch {
    return false
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * Share a wallet's collection card: the native share sheet on touch devices,
 * the clipboard otherwise. Reports what actually happened — callers must not
 * say "copied" on a failed copy (the old buttons did, unconditionally).
 */
export async function shareWalletCard(
  wallet: string,
  origin?: string,
): Promise<ShareOutcome> {
  if (canNativeShare()) {
    try {
      await navigator.share({
        title: "My collection on Rip Packs City",
        url: walletShareUrl(wallet, "native", origin),
      })
      return "shared"
    } catch (e) {
      // The user closing the sheet is not a failure, and must not silently
      // turn into a clipboard write they did not ask for.
      if (e instanceof Error && e.name === "AbortError") return "cancelled"
      // Any other refusal (permissions, unsupported payload): copy instead.
    }
  }
  return (await copyText(walletShareUrl(wallet, "copy", origin))) ? "copied" : "failed"
}
