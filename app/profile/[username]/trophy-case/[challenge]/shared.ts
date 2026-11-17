// Shared by the page and its layout's generateMetadata (both memoized reads).
//
// The challenge's DISPLAY title comes from the entry when we have it; when the
// read failed we still owe the page a heading, and the slug in the URL names
// the same challenge (never another subject), so it is title-cased from that.

export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

/**
 * The line under the card. INVARIANT (same as `trophyCaseDescription`): it never
 * emits a zero — an unread or empty count falls out of the sentence.
 */
export function challengeCaseDescription(input: { displayName: string; title: string; filled: number | null }): string {
  const { displayName, title, filled } = input
  if (filled && filled > 0) {
    return `${filled} of 6 ${title} pieces picked by ${displayName} — their entry in the ${title} trophy challenge on Rip Packs City.`
  }
  return `${displayName}'s entry in the ${title} trophy challenge on Rip Packs City.`
}
