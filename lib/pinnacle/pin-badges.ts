// lib/pinnacle/pin-badges.ts
//
// Disney Pinnacle's OWN badges (2026-11-23). Each collection has its own badge art: Top Shot's momentTags, All Day's
// badgesV3 — and Disney Pinnacle's, published with their definitions on disneypinnacle.com/news/digital-pins-101
// (round icons served from Pinnacle's Contentful space, read 2026-11-23 in Chrome). The 09-27 note "Disney Pinnacle
// has no badge program" (lib/collections.ts) was about Top Shot-style badge FILTERS on the Market tab; it stays true
// for that table, and is not a statement that Pinnacle has no badges.
//
// Which badge a pin earns is derived ONLY from catalog facts whose meaning Pinnacle's own page defines:
//   Starter Edition  — edition_type "Starter Edition"
//   Open Edition     — "Open Edition" / "Open Event Edition"
//   Limited Edition  — "Limited Edition" / "Limited Event Edition" ("each has a maximum mint count")
//   First Printing   — an Open Edition pin with printing = 1 ("the initial production run"; reissues are not)
//   Single Printing  — a Limited Edition pin ("all are single printings"; no more will ever be minted)
//   Chaser           — is_chaser
// NOT shown, because no catalog field says so (a badge is a claim, never a guess): Magic Reveal, Pin Limitation
// (also the "no lock UI" rule — is_locked is contract maturity), and the drop mechanics (Revolving Storefront,
// Mystery Capsule, Limited Supply, Don't Miss the Drop!), which describe how a release is SOLD, not the pin.
// Legendary and Genesis editions have no published badge, so they earn none of the edition badges.

export const PINNACLE_BADGE_SLUGS = [
  "starter-edition",
  "open-edition",
  "limited-edition",
  "first-printing",
  "single-printing",
  "chaser",
] as const
export type PinnacleBadgeSlug = (typeof PINNACLE_BADGE_SLUGS)[number]

/** Contentful asset paths (space 2s37rzr5a7pw) of Pinnacle's badge art — the 687×80 banner, icon at the left. */
export const PINNACLE_BADGE_ASSETS: Record<PinnacleBadgeSlug, string> = {
  "starter-edition": "6UsGAeDYTlS0OkGqYG0GqX/d456957d9580327a2ffa11d17f477dea/Starter_Edition.png",
  "open-edition": "7onyzu9Wb4rXv5TVCqDZDo/9e711284095d84658fd5a23d426eeab0/Open_Edition.png",
  "limited-edition": "30azuQLysyIQwYqUnu7COw/8465d435837a0a5d8b3322d76b96005b/Limited_Edition.png",
  "first-printing": "24iBIEEFY9Lk4KZ4QMVKKK/6763dd2f24981c686e849d3cb22bcce7/First_Printing.png",
  "single-printing": "462pMFAP9olVamceEVImnx/75b5acffa0430b8151d44e908cb325c4/Single_Printing.png",
  chaser: "4wGJodrGo2GozJNFIGfMTR/790e7c6f0effadce2cb6461686a56a4f/Chaser.png",
}

export const PINNACLE_BADGE_LABELS: Record<PinnacleBadgeSlug, string> = {
  "starter-edition": "Starter Edition",
  "open-edition": "Open Edition",
  "limited-edition": "Limited Edition",
  "first-printing": "First Printing",
  "single-printing": "Single Printing",
  chaser: "Chaser",
}

/** Pinnacle's own one-line definitions (disneypinnacle.com/news/digital-pins-101), paraphrased for the tooltip. */
export const PINNACLE_BADGE_MEANINGS: Record<PinnacleBadgeSlug, string> = {
  "starter-edition": "A Starter Edition pin, made to help new collectors begin a set.",
  "open-edition": "An Open Edition pin, minted while it is on sale.",
  "limited-edition": "A Limited Edition pin, with a maximum mint count.",
  "first-printing": "From the pin's initial production run; later reissues are not First Printings.",
  "single-printing": "A single printing: once it sells out, no more of this pin will be minted.",
  chaser: "A Chaser: lower odds of being revealed from a Mystery Capsule than the rest of its set.",
}

export function isPinnacleBadgeSlug(v: string | null | undefined): v is PinnacleBadgeSlug {
  return v != null && (PINNACLE_BADGE_SLUGS as readonly string[]).includes(v)
}

/** Same-origin URL of a badge icon, via /api/badge-image (CSP allows no Contentful host). */
export function pinnacleBadgeIconUrl(slug: PinnacleBadgeSlug): string {
  return `/api/badge-image?src=pinnacle&name=${slug}`
}

/** Pure: the badges a pin earns, in Pinnacle's own order. */
export function pinnacleBadgesFor(pin: { edition_type: string | null; printing: number | null; is_chaser: boolean | null }): PinnacleBadgeSlug[] {
  const out: PinnacleBadgeSlug[] = []
  const et = (pin.edition_type ?? "").trim()
  const open = et === "Open Edition" || et === "Open Event Edition"
  const limited = et === "Limited Edition" || et === "Limited Event Edition"
  if (et === "Starter Edition") out.push("starter-edition")
  if (open) out.push("open-edition")
  if (limited) out.push("limited-edition")
  if (open && pin.printing === 1) out.push("first-printing")
  if (limited) out.push("single-printing")
  if (pin.is_chaser === true) out.push("chaser")
  return out
}
