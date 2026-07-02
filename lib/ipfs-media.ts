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
