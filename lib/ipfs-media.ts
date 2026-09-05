// lib/ipfs-media.ts
//
// Rewrites slow public-gateway IPFS media URLs (https://ipfs.io/ipfs/<cid>) to
// our same-origin, edge-cached proxy (/api/public/ipfs-media/<cid>) so heavy
// UFC/legacy assets paint reliably instead of timing out on ipfs.io. See
// app/api/public/ipfs-media/[cid]/route.ts. Non-ipfs.io URLs (typed CDN URLs
// used by Top Shot / All Day / Golazos / Pinnacle) pass through untouched.

// Matches a public IPFS-gateway path form and captures the CID. Covers the two
// slow/flaky gateways whose bare `/ipfs/<cid>` art we proxy: ipfs.io (UFC /
// legacy) and ipfs.dapperlabs.com (pre-2022 Top Shot Series-1 moments). Both
// serve the same content-addressed CID, so the same-origin proxy (which fetches
// upstream from ipfs.io) resolves either.
//
// ⚠ cloudflare-ipfs.com STAYS IN THIS REGEX even though it was dropped from the
// proxy.ts CSP on 2026-09-05. The original reason given was "parity with the CSP"
// and that reason is now dead, but the entry earns its place on its own: matching
// it REWRITES a legacy cloudflare URL onto our same-origin proxy, which resolves
// the CID from a gateway that is still alive. Deleting it would leave such a URL
// hotlinking a decommissioned host — i.e. removing it makes the failure WORSE,
// which is the opposite of what "keep it in sync with the CSP" would suggest.
const IPFS_GATEWAY_RE =
  /^https?:\/\/(?:ipfs\.io|ipfs\.dapperlabs\.com|cloudflare-ipfs\.com)\/ipfs\/([A-Za-z0-9]+)/;

export function proxyIpfsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(IPFS_GATEWAY_RE);
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
  const m = url.match(IPFS_GATEWAY_RE);
  if (!m) return url;
  return `${baseUrl}/api/public/ipfs-media/${m[1]}`;
}
