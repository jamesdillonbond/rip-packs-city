// scripts/panini-pack-grid.mjs — find Panini's SECONDARY-MARKET pack listings, not just the drops.
//
// WHY (2026-10-03): Trevor — "They have plenty of other packs that are selling on the secondary,
// they just don't have frequent pack drops." panini_pack_pages held 4 pages (WC Hobby + FOTL, the
// two WNBA drop pages), because pack pages were only ever found as links on pages the card walk
// visits — the home page (current drops) and the card grids, which link cards, never packs. The 15
// "pack-ish unmatched" links every enum marker kept were all /packcard-… CARD pages, so they hid any
// real pack link. A secondary pack is a /marketplace-details/subpack-<n>-<pack_id>.html page (it
// fires getPackMarketStats, which the ingest already stores), and those pages load a pack filter
// op (packFiltersMetaTimestamp) — so the marketplace has a pack listing to walk. Its URL is not
// recorded anywhere, so the runner finds it: nav links that look like a pack marketplace, plus a
// conventional guess, each visited, scrolled and searched for subpack links. What each candidate
// yielded is reported in the enum marker (`pack_grid`), so the next session reads the answer.
// Pure helpers; the browser half lives in ingest-panini-runner.mjs.

const BASE = "https://nft.paniniamerica.net";
const SUBPACK_RE = /marketplace-details\/subpack-(\d+)-(\d+)/g;

/** A pack-ish href worth keeping as evidence: mentions "pack" but is not a /packcard- CARD page. */
export function isPackishEvidence(u) {
  return typeof u === "string" && /pack/i.test(u) && !/\/packcard-/i.test(u);
}

/** Every subpack listing URL mentioned anywhere in a page's HTML (router links may carry no href). */
export function subpackUrlsFromHtml(html) {
  const out = new Set();
  if (typeof html !== "string") return [];
  for (const m of html.matchAll(SUBPACK_RE)) out.add(`${BASE}/marketplace-details/subpack-${m[1]}-${m[2]}.html`);
  return [...out];
}

/**
 * Pages that may list packs for sale: on-site nav links whose PATH names a pack marketplace (not a
 * card page, not a single pack page), then `extra` (env override), then the conventional guess.
 * then one listing per sport (the bare listing serves Basketball only). Deduped on URL, capped —
 * each costs a page load.
 */
export function packGridCandidates(hrefs, extra = [], max = 4, sports = []) {
  const out = [];
  const seen = new Set();
  const add = (u) => {
    if (out.length >= max || typeof u !== "string" || !u.startsWith(BASE + "/")) return;
    const k = u.split("#")[0];
    if (seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  for (const h of Array.isArray(hrefs) ? hrefs : []) {
    if (typeof h !== "string") continue;
    const path = h.slice(BASE.length).split("#")[0].split("?")[0];
    if (/\/packcard-|\/marketplace-details\/|\/pack-[^/]+$/i.test(path)) continue; // a card, or ONE pack
    if (/^\/marketplace\/[^/]*pack/i.test(path) || /^\/(?:[^/]*-)?packs?(?:\.html)?$/i.test(path)) add(h);
  }
  for (const u of extra) add(u);
  add(`${BASE}/marketplace/packs.html`);
  // 2026-10-03 (measured): /marketplace/packs.html redirects to ?sport=Basketball and lists only that
  // sport's packs (64 subpack links, all basketball). Every other sport is its own listing.
  for (const sp of Array.isArray(sports) ? sports : []) {
    if (typeof sp === "string" && sp.trim()) add(`${BASE}/marketplace/packs.html?sport=${encodeURIComponent(sp.trim())}`);
  }
  return out;
}
