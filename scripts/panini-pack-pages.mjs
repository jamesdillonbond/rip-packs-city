// Which pack pages the residential Panini runner opens this run, as a pure function so it can be
// tested (the runner needs a logged-in Chrome and cannot run in CI). Extracted from
// scripts/ingest-panini-runner.mjs 2026-11-22.
//
// `served` is the route's list (panini_pack_pages, enabled, STALEST WALK FIRST, never-walked first of
// all); `harvested` is what this run's grid pages linked to. At most `max` pages are opened.
//
// ⛔ 2026-11-22: the runner used to sort the WHOLE list subpack-first and THEN take `max`. With 404
// enabled /marketplace-details/subpack-… pages against a cap of 60, every /pack-<name>.html DROP page
// sat behind the cut forever: the NWSL (#1065), World Cup Sticker and Rolling Stones drop pages were
// registered on 11-13/10-26/11-06 and NEVER opened, and the route's stalest-first rotation was undone
// on every run. So: take the `max` stalest FIRST, then order WITHIN that slice subpack-first — the
// original reason for subpack-first (a product that has a subpack page keeps its numeric pack id when
// both of its pages are visited in the same run) still holds for any pair inside the slice.
export function selectPackPages(served, harvested, max) {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  const ordered = [...new Set([...(served ?? []), ...(harvested ?? [])])];
  return ordered
    .slice(0, cap)
    .sort((a, b) => Number(b.includes("/subpack-")) - Number(a.includes("/subpack-")));
}
