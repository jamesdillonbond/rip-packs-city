// lib/media/servable-media-type.ts
//
// Which upstream content types a same-origin media proxy may stream back
// (security audit 2026-10-25). Raster images and video only: HTML, SVG, XML,
// JSON and octet-stream can all be rendered as a DOCUMENT on our origin when a
// visitor opens the URL directly, and for /api/public/ipfs-media the bytes are
// caller-chosen (anyone can pin content to IPFS).

const SERVABLE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

/** Raster image or video only — never HTML, SVG, XML, JSON or octet-stream. */
export function isServableMediaType(contentType: string | null): boolean {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return SERVABLE_MEDIA_TYPES.has(base);
}
