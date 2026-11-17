// lib/edition/description.ts
//
// `editions.description` is the upstream prose for the play — the paragraph the
// Top Shot and All Day moment pages render — captured by lib/editions-hydrate.ts
// since 2026-08-12 and, until review item E4 (2026-10-11), read by nothing but
// rpc_search_catalog. get_edition_detail now carries it; these two helpers are
// the ONLY way the edition page and its <meta description> read it.
//
// THREE states, TWO renders. The column is NULL on every edition the ingest has
// not described (and on every Pinnacle arm, by construction), and it can be an
// empty or whitespace-only string where an upstream exposed the field blank.
// Both are ABSENCE. A renderer gated on `detail.description != null` would print
// an empty <p> for the blank string; one that fell back to "No description" would
// publish a claim about the edition out of a gap in our ingest — the honesty
// class this repo keeps re-finding. So both helpers return `null` for anything
// without content, and callers gate on THAT, never on the raw column.

/** Google truncates a meta description around this width (2026-09 Search Console reads). */
export const EDITION_DESCRIPTION_META_MAX = 160

/**
 * The prose as a renderable paragraph: whitespace collapsed and trimmed, or
 * `null` when there is nothing to render (non-string, empty, whitespace-only).
 */
export function editionDescriptionText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length > 0 ? collapsed : null
}

// A terminal `.` that ends an abbreviation, not a sentence ("Vol. 2", "J. Cole",
// "vs. the Lakers"). Kept short on purpose: this decides where a SNIPPET stops,
// and a wrong cut costs a few words of a meta description, nothing more.
const ABBREVIATION_TAIL = /(?:^|\s)(?:vs|ft|no|vol|jr|sr|st|mr|mrs|ms|dr|[a-z])\.$/i

/**
 * The first sentence of the prose, capped at `max` characters, for a meta
 * description seed. `null` when `editionDescriptionText` is null, so a caller's
 * "otherwise keep today's text" branch is one `??` away.
 */
export function editionDescriptionSnippet(
  value: unknown,
  max: number = EDITION_DESCRIPTION_META_MAX,
): string | null {
  const text = editionDescriptionText(value)
  if (!text) return null
  let sentence = text
  const re = /[.!?]["'”’)]*(?=\s|$)/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const candidate = text.slice(0, m.index + m[0].length)
    if (ABBREVIATION_TAIL.test(candidate)) continue
    sentence = candidate
    break
  }
  if (sentence.length <= max) return sentence
  // Cut on a word boundary and say so — a hard truncation reads as a typo.
  const room = Math.max(1, max - 1)
  const cutAt = sentence.lastIndexOf(" ", room)
  const head = (cutAt > 0 ? sentence.slice(0, cutAt) : sentence.slice(0, room)).replace(/[\s,;:—–-]+$/, "")
  return `${head}…`
}
