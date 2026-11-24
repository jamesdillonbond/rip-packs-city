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
