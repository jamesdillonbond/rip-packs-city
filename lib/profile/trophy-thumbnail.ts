// Trophy-slab art: what a PIN is allowed to point at.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// `POST /api/profile/trophy` took every display field straight from the request
// body. Most of them turn out not to matter: `get_trophy_slab_data` renders
// public slabs with `COALESCE(e.<field>, tm.<field>)`, so the live `editions`
// row WINS and a forged player/tier/FMV is overridden whenever the edition
// resolves. Two stored fields are NOT coalesced and are published as-is —
// `serial_number` and `thumbnail_url`.
//
// `thumbnail_url` is the one with teeth. It is rendered on a public profile AND
// FETCHED SERVER-SIDE by `/api/og/profile/[username]`, which inlines trophy art
// as data URIs. An arbitrary URL there is an arbitrary image on someone's public
// page plus a server-side fetch of an attacker-chosen host.
//
// ⚠ NOT AN INCIDENT — a latent vector. Measured 2026-09-03: 19 trophy rows
// across 7 users, every thumbnail on a legitimate host. This closes the door
// before the campaign opens it.
//
// ── THE LIST IS DERIVED, NOT GUESSED ────────────────────────────────────────
// Every host below came from `SELECT regexp_replace(thumbnail_url, …) FROM
// editions GROUP BY 1` on 2026-09-03 — the hosts our own catalogue actually
// uses, with row counts:
//
//   assets.nbatopshot.com   11,064      ipfs.io                518
//   media.nflallday.com      6,190      arweave.net            125
//   ipfs.dapperlabs.com      2,248      storage.googleapis.com  13
//   assets.laligagolazos.com   575
//
// ⚠ Re-derive before adding a collection. A guessed allowlist silently drops the
// art for whichever host it forgot, and the slab renders blank with nothing to
// explain it — so widen this from the QUERY, never from memory.
const ALLOWED_HOSTS = new Set([
  "assets.nbatopshot.com",
  "media.nflallday.com",
  "ipfs.dapperlabs.com",
  "assets.laligagolazos.com",
  "ipfs.io",
  "arweave.net",
  "storage.googleapis.com",
]);

/**
 * Same-origin proxy paths. Disney Pinnacle art is served through our own
 * `/api/public/pinnacle-image/<key>` route rather than a CDN host, so a
 * host-only allowlist would reject the one collection that needs it.
 * Restricted to that prefix: a bare `/` would let a pin point at any internal
 * route, and `//evil.com` is protocol-relative — an absolute URL wearing a
 * relative disguise, which is why the second character is checked.
 */
function isAllowedSameOriginPath(raw: string): boolean {
  return raw.startsWith("/api/public/") && !raw.startsWith("//");
}

/**
 * Returns the URL when it is one we are willing to publish, else null.
 *
 * Null rather than an error: the slab still pins and the art simply falls back,
 * which is the honest outcome — we could not stand behind that image, and a
 * user who picked from their own collection never hits this path anyway.
 */
export function sanitizeTrophyThumbnail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (!url) return null;
  if (isAllowedSameOriginPath(url)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // https only. `http:` is downgrade-able and `data:`/`javascript:` are the
  // shapes that turn an <img src> into something else.
  if (parsed.protocol !== "https:") return null;
  return ALLOWED_HOSTS.has(parsed.hostname) ? url : null;
}
