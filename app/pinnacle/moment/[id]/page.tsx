// app/pinnacle/moment/[id]/page.tsx
//
// PERMANENT REDIRECT ONLY — the Disney Pinnacle edition page moved to
// /disney-pinnacle/edition/<render_id> on 2026-09-20.
//
// ── WHY THE URL MOVED ───────────────────────────────────────────────────────
// This was the only published collection whose canonical entity page lived
// outside `(collections)/[collection]/…`, under a slug (`pinnacle`) that is not
// the collection's URL slug (`disney-pinnacle`), named with a noun (`moment`)
// the page never used for itself — its metadata said "Pinnacle edition" and its
// legacy title said "N editions on …". The house-correct URL already existed
// and 308'd the other way. A Pinnacle render is the edition-grain object, so
// `/disney-pinnacle/edition/<render_id>` is what it is called everywhere else.
//
// ⛔ DO NOT DELETE THIS ROUTE. It carried real traffic (125 visitors / 173
// pageviews in the 30 days to 2026-09-20, the 11th busiest route on the site)
// and ~2,600 of its URLs were in the sitemap, so it is load-bearing for search
// signals and for every link already in the wild. A 308 transfers those; a 404
// throws them away. This file should outlive everyone who remembers why.
//
// ⚠ The slug is passed through ENCODED exactly as received. Legacy set-level
// keys contain ':' and spaces (e.g. "STAR-OEV1-SWHM:Digital Display:1") and the
// destination decodes for itself, so decoding here would double-decode.

import { permanentRedirect } from "next/navigation"

export default async function PinnacleMomentRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  permanentRedirect(`/disney-pinnacle/edition/${encodeURIComponent(decodeURIComponent(id))}`)
}
