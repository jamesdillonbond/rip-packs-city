// lib/ipfs-media.ts
//
// Rewrites slow public-gateway IPFS media URLs (https://ipfs.io/ipfs/<cid>) to
// our same-origin, edge-cached proxy (/api/public/ipfs-media/<cid>) so heavy
// UFC/legacy assets paint reliably instead of timing out on ipfs.io. See
// app/api/public/ipfs-media/[cid]/route.ts. Non-ipfs.io URLs (typed CDN URLs
// used by Top Shot / All Day / Golazos / Pinnacle) pass through untouched.

// Matches the public ipfs.io gateway path form and captures the CID.
const IPFS_IO_RE = /^https?:\/\/ipfs\.io\/ipfs\/([A-Za-z0-9]+)/;

export function proxyIpfsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(IPFS_IO_RE);
  if (!m) return url;
  return `/api/public/ipfs-media/${m[1]}`;
}

// Absolute-URL variant for contexts that require a fully-qualified URL rather
// than a same-origin path — notably JSON-LD structured data and OG/meta image
// fields, where a relative path is invalid. Rewrites slow ipfs.io CIDs to the
// edge-cached proxy under baseUrl; non-ipfs.io URLs (typed CDN art) pass through.
export function proxyIpfsUrlAbsolute(
  url: string | null | undefined,
  baseUrl: string
): string | null {
  if (!url) return null;
  const m = url.match(IPFS_IO_RE);
  if (!m) return url;
  return `${baseUrl}/api/public/ipfs-media/${m[1]}`;
}
