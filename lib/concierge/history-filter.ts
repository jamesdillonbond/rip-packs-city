// PostgREST `or=` filter selecting the signed-in user's own concierge rows
// (2026-10-03). Values are double-quoted — PostgREST's reserved-character
// quoting — so an email or username holding , ( ) . cannot break out of its
// own clause, and LIKE wildcards in the email are escaped so `ilike` is an
// exact (case-insensitive) match, never a pattern.
function quoted(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function likeLiteral(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function mineFilter(email: string, ownerKey: string | null): string {
  const parts = [`user_email.ilike.${quoted(likeLiteral(email))}`];
  if (ownerKey) parts.push(`owner_key.eq.${quoted(ownerKey)}`);
  return parts.join(",");
}
