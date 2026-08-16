// app/edition/[id]/page.tsx
// Phase 1G. Redirect from the legacy flat /edition/[uuid] route to the
// canonical nested /[collection]/edition/[external_id] path. The full
// SEO-rendering implementation moved to
// app/(collections)/[collection]/edition/[slug]/page.tsx in Phase 1B.

import { notFound, redirect } from "next/navigation"
import { getCollectionByDbSlug } from "@/lib/collection-slug"
import { lookupLegacyEdition, UUID_RE } from "@/lib/edition/legacy-redirect"

export const dynamic = "force-dynamic"

export default async function LegacyEditionRedirect(
  props: { params: Promise<{ id: string }> }
) {
  const { id } = await props.params
  if (!UUID_RE.test(id)) notFound()

  const { target, ok } = await lookupLegacyEdition(id)

  // ⚠ A FAILED read must not 404. This route catches LEGACY inbound links, so a
  // statement timeout here hands a hard 404 for an edition that exists, to the
  // audience least likely to retry. Throwing renders the retryable error
  // boundary; a genuine miss still 404s on the line below.
  if (!ok) throw new Error("edition redirect unavailable")
  if (!target) notFound()

  const coll = getCollectionByDbSlug(target.collectionDbSlug)
  if (!coll) notFound()

  redirect(`/${coll.urlSlug}/edition/${encodeURIComponent(target.externalId)}`)
}
