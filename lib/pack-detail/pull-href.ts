// lib/pack-detail/pull-href.ts
//
// Where a pull card on /[collection]/pack/[id] links. Top Shot and All Day pulls
// resolve as moments (`/moment/<nft_id>` → get_moment_detail reads `moments`).
// Golazos and Pinnacle have NO per-NFT `moments` rows (0 each, read 2026-10-19),
// so that link 404'd for every pull: they link by the pull's `edition_key` —
// the Golazos edition external_id (the edition page resolves by it) and the
// Pinnacle render_id (the per-pin page, /pinnacle/moment/<render_id>).
// No key → no link (null), never a guessed one.

export function pullHref(
  collection: string,
  pull: { nft_id: string; edition_key?: string | null },
): string | null {
  if (collection === "laliga-golazos") {
    return pull.edition_key ? `/laliga-golazos/edition/${encodeURIComponent(pull.edition_key)}` : null
  }
  if (collection === "disney-pinnacle") {
    return pull.edition_key ? `/pinnacle/moment/${encodeURIComponent(pull.edition_key)}` : null
  }
  return `/${collection}/moment/${encodeURIComponent(pull.nft_id)}`
}
