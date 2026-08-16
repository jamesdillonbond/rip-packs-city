// lib/profile/avatar-url.ts
//
// What is wrong with an avatar URL, said in words the collector can act on.
//
// WHY (2026-08-16). /profile/edit accepted any string, saved it, and said
// nothing. A real collector pasted
//   https://opensea.io/item/ethereum/0x5b43…e706d/2232
// — the OpenSea ITEM PAGE, not the artwork — and got a broken avatar with no
// indication anything was wrong. It renders as the monogram fallback, which
// looks exactly like never having set an avatar at all, so there is nothing on
// screen to tell them the value they typed is the problem.
//
// This is the shape the failure takes every time: a URL that is perfectly valid
// and points at HTML. Nothing about it looks wrong, and the page cannot tell
// the difference until an <img> tries to decode it.
//
// ⚠ THESE ARE WARNINGS, NOT A BLOCK. Saving is never prevented. A host can be
// down for a minute, a CDN can refuse an unusual referrer, and an avatar that
// fails to load today may be fine tomorrow — refusing the save would strand a
// collector over a transient failure. The job here is to make the problem
// VISIBLE, which is the whole of what was missing.

/**
 * Marketplace/NFT hosts whose item URLs are HTML pages, not images.
 *
 * ⚠ APEX + `www.` ONLY — deliberately NOT `(^|\.)host$`. Those same brands
 * serve their ARTWORK from subdomains (`assets.nbatopshot.com`, and OpenSea's
 * images come off `i.seadn.io` entirely), and a direct link to one of those is
 * EXACTLY what this warning tells the collector to paste. A subdomain-matching
 * pattern flags the correct answer as wrong, which is worse than not warning at
 * all — it argues with someone who has just done what you asked. Caught by
 * `assets.nbatopshot.com` in the test below, not by review.
 */
const MARKETPLACE_PAGE = [
  { host: /^(www\.)?opensea\.io$/i, name: "OpenSea" },
  { host: /^(www\.)?blur\.io$/i, name: "Blur" },
  { host: /^(www\.)?magiceden\.(io|us)$/i, name: "Magic Eden" },
  { host: /^(www\.)?rarible\.com$/i, name: "Rarible" },
  { host: /^(www\.)?nbatopshot\.com$/i, name: "NBA Top Shot" },
  { host: /^(www\.)?nflallday\.com$/i, name: "NFL All Day" },
  { host: /^(www\.)?flowty\.io$/i, name: "Flowty" },
]

/** A path ending in an image extension is an image, whoever is hosting it. */
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|avif|svg)$/i

export type AvatarUrlVerdict =
  /** Blank — the collector gets the RPC logo (lib/profile/default-avatar.ts). */
  | { kind: "empty" }
  /** Nothing obviously wrong. NOT a promise that it loads — only a fetch proves that. */
  | { kind: "ok" }
  /** Still being typed. Deliberately silent: warning on every keystroke is noise. */
  | { kind: "incomplete" }
  | { kind: "not-a-url"; message: string }
  | { kind: "marketplace-page"; message: string }
  | { kind: "insecure"; message: string }

/**
 * Classify what the collector has typed into the avatar field.
 *
 * ⚠ Deliberately NOT a fetch. This runs on every keystroke in the editor, and
 * a network probe per character would be both slow and a way to make a
 * collector's browser hammer a third-party host. Whether the URL actually
 * resolves to an image is answered by the live preview's <img>, which is the
 * only fully honest test and costs nothing extra.
 */
export function classifyAvatarUrl(raw: string | null | undefined): AvatarUrlVerdict {
  const value = (raw ?? "").trim()
  if (value === "") return { kind: "empty" }

  // Mid-typing. `h`, `htt`, `https:/` are all on the way to something valid, and
  // scolding someone for the third character of a URL they are still writing is
  // exactly the kind of validation people learn to ignore.
  if (!/^https?:\/\/\S+$/i.test(value)) {
    if (/^h(t(t(p(s?(:(\/(\/)?)?)?)?)?)?)?$/i.test(value) || value.length < 12) {
      return { kind: "incomplete" }
    }
    return {
      kind: "not-a-url",
      message: "That does not look like a web address. An avatar has to be a link to an image file, starting with https://",
    }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return {
      kind: "not-a-url",
      message: "That does not look like a web address. An avatar has to be a link to an image file, starting with https://",
    }
  }

  // An explicit image extension settles it before any host rule gets a say, so
  // a direct image link is never second-guessed on account of where it lives.
  const marketplace = IMAGE_PATH.test(url.pathname)
    ? undefined
    : MARKETPLACE_PAGE.find((m) => m.host.test(url.hostname))
  if (marketplace) {
    return {
      kind: "marketplace-page",
      message:
        `That is a link to the ${marketplace.name} PAGE for your item, not to the picture itself — ` +
        `so it will not load as an avatar. Open the link, right-click the artwork, ` +
        `choose "Copy image address", and paste that here instead.`,
    }
  }

  // ⚠ A REAL, NON-OBVIOUS ASYMMETRY, not pedantry about https. The profile page
  // renders an http:// image fine, but app/api/og/profile/[username] gates its
  // prefetch on startsWith("https://") — so an http avatar silently vanishes
  // from the social card, which is the ONE place the avatar is seen by people
  // who are not already on the site. Worth a sentence; not worth blocking.
  if (url.protocol === "http:") {
    return {
      kind: "insecure",
      message:
        "This works on your profile, but link previews on X and Discord will fall back to your initials — " +
        "they only accept https:// images. Use the https:// version of this link if there is one.",
    }
  }

  return { kind: "ok" }
}

/** The message to show, or null when there is nothing useful to say. */
export function avatarUrlWarning(raw: string | null | undefined): string | null {
  const v = classifyAvatarUrl(raw)
  return "message" in v ? v.message : null
}
