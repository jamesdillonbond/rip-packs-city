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
//
// ✅ RE-DERIVED 2026-09-05: the host SET is unchanged — the same seven, no new
// arrival. Only the counts moved (assets.nbatopshot.com 11,064 → 11,667,
// ipfs.dapperlabs.com 2,248 → 2,335; the other five identical).
// ⭐ Which is the point of re-running it: a COUNT moving while MEMBERSHIP holds
// is the case where "the numbers changed, so the list must be stale" and "the
// numbers are the same, so nothing changed" are BOTH wrong. Diff the set.
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
 * Top Shot / Golazos static renders. The filename is the asset:
 * `/editions/<set>/<uuid>/play_<uuid>_<set>_capture_<Variant>_2880_2880_<bg>.png`
 * — and the `play_…` segment is always the LAST one and always carries an image
 * extension.
 *
 * ⭐ WHY THIS IS CHECKED AT ALL, since the host allowlist already passed it.
 * One live row is a TRUNCATED HYBRID of the two Top Shot URL shapes:
 * `…/play_<uuid>_<set>_capture_/image` — the static filename cut off at
 * `capture_`, with the render endpoint's `/image` glued on. It 404s, so that
 * collector's only pinned trophy published as a blank slab on their profile
 * card (found 2026-09-12; 1 of 22 trophy rows, and they are one of the 4 of 7
 * collectors who have pinned exactly one Moment, so it was their WHOLE case).
 *
 * ⚠ "AN /editions/ PATH MUST END IN AN IMAGE EXTENSION" IS THE RULE I DID NOT
 * WRITE, and measuring first is why: all 6,190 NFL All Day editions address art
 * as `/editions/<n>/media/image` — an extensionless `/editions/` path that is
 * perfectly valid. The discriminator is the `play_` segment, which is what
 * marks a STATIC FILENAME, and a static filename that is not the end of the
 * path has been truncated.
 */
function isTruncatedStaticRender(pathname: string): boolean {
  const segs = pathname.split("/").filter(Boolean)
  const i = segs.findIndex((seg) => seg.startsWith("play_"))
  if (i === -1) return false
  return i !== segs.length - 1 || !/\.(png|jpe?g|gif|webp|avif)$/i.test(segs[i])
}

/**
 * Returns the URL when it is one we are willing to publish, else null.
 *
 * Null rather than an error: the slab still pins and the art simply falls back,
 * which is the honest outcome — we could not stand behind that image, and a
 * user who picked from their own collection never hits this path anyway.
 *
 * ⚠ "FALLS BACK" ONLY BECAME TRUE ON 2026-09-12, and this comment was making a
 * promise the stack did not keep: `get_trophy_slab_data` passed
 * `tm.thumbnail_url` straight through — the ONE display field in a column of
 * `COALESCE(e.<live>, tm.<snapshot>)` that had no live side — so a rejected pin
 * stored NULL and every surface drew "ART UNAVAILABLE" rather than falling back
 * to anything. The RPC now coalesces to the edition's own art, which is what
 * makes rejecting here safe rather than destructive.
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
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;
  if (isTruncatedStaticRender(parsed.pathname)) return null;
  return url;
}
