// lib/seo/json-ld-script.ts
//
// Serialise structured data for an inline <script type="application/ld+json">
// (security audit 2026-10-25).
//
// ⛔ `JSON.stringify` ALONE IS NOT SAFE INSIDE A <script> ELEMENT. It does not
// escape `<`, so a string value containing `</script>` ends the element early
// and whatever follows is parsed as HTML — a `<script>` there RUNS, as our
// origin, under `script-src 'self' 'unsafe-inline'`. Most JSON-LD on this site
// carries names that come from the database (players, teams, sets, editions,
// wallet personas), i.e. from upstream feeds and user-chosen handles, not from
// our own copy. Escaping `<`, `>` and `&` as < / > / & leaves
// the JSON identical once parsed, and U+2028/U+2029 are escaped for older JS
// parsers that treat them as line terminators.
//
// Use this for every `dangerouslySetInnerHTML={{ __html: ... }}` that emits
// JSON; `__tests__/json-ld-is-script-safe.test.ts` bans the bare form.

export function jsonLdScript(data: unknown): string {
  const json = JSON.stringify(data) ?? "null"
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}
