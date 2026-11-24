// lib/og/card-day-key.ts
//
// Today's Pacific date as YYYYMMDD, appended to a board's og:image URL as ?d= so X sees each day's
// card as a NEW image. X caches a link card by the IMAGE URL as well as the page URL, and keeps a
// failed fetch as a blank grey placeholder: changing ?w= on the page link does not help while the
// og:image URL is the same bare URL X cached before (drops 11-15: last week's card; top-sales 11-23:
// a blank placeholder). The OG routes ignore the param. Computed at render; boards revalidate every
// 900 s, so the key rolls over within 15 min of PT midnight.
export function ogCardDayKey(now: Date = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  )
  return `${p.year}${p.month}${p.day}`
}

/**
 * The deploy's short commit sha, for a board whose metadata is STATIC (`export const metadata`):
 * appended as ?v= it gives every deploy a new og:image URL, so a card X cached blank (or stale)
 * never outlives the next deploy. Falls back to the build day when the sha is absent (local builds).
 * Boards with generateMetadata use ogCardDayKey() instead (a new URL every PT day).
 */
export const OG_CARD_VERSION: string = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || ogCardDayKey()
