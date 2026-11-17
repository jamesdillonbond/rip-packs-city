// Shared by metadata-inline-blocks-inherit-root-fields.test.ts and
// inline-opengraph-blocks-carry-an-image.test.ts — moved here 2026-11-06 so the
// second guard does not import (and re-register) the first guard's suite.
/**
 * Balanced-brace extraction of every `<key>: { … }` object literal.
 *
 * ⚠ A regex over the call head is not enough: these blocks nest (`images: [{…}]`)
 * and run to 20 lines, so the fields we care about can sit anywhere inside. The
 * leading-boundary group keeps `openGraph:` from matching `foo.openGraph:`.
 *
 * ⚠ AND THE SCANNER MUST BE STRING-AWARE, which the first version was not — my
 * own nested fixture caught it. A `}` inside a quoted `alt:` string closes the
 * block early, so the tail is never read and the guard reports fields that ARE
 * present. A FALSE POSITIVE is the expensive direction here: it reds CI on
 * correct code, and the next person weakens the guard to get green. Backticks
 * matter most — these files build URLs as `${SITE_URL}/…` templates.
 */
export function objectLiterals(src: string, key: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(^|[^A-Za-z0-9_$.])${key}\\s*:\\s*\\{`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = src.indexOf("{", m.index + m[0].length - 1)
    let i = open + 1
    let depth = 1
    let quote: string | null = null
    while (i < src.length && depth > 0) {
      const c = src[i]
      const prev = src[i - 1]
      if (quote) {
        if (c === quote && prev !== "\\") quote = null
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c
      } else if (c === "{") depth++
      else if (c === "}") depth--
      i++
    }
    out.push(src.slice(open + 1, i - 1))
  }
  return out
}
