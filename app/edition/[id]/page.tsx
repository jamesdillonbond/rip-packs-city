// app/edition/[id]/page.tsx
// Phase 1G. Redirect from the legacy flat /edition/[uuid] route to the
// canonical nested /[collection]/edition/[external_id] path. The full
// SEO-rendering implementation moved to
// app/(collections)/[collection]/edition/[slug]/page.tsx in Phase 1B.

import { notFound, redirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByDbSlug } from "@/lib/collection-slug"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function LegacyEditionRedirect(
  props: { params: Promise<{ id: string }> }
) {
  const { id } = await props.params
  if (!UUID_RE.test(id)) notFound()

  const client = supabaseAdmin as unknown as {
    from: (t: string) => {
      select: (s: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => Promise<{ data: { external_id: string | null; collections: { slug: string } | null } | null; error: { message: string } | null }>
        }
      }
    }
  }

  const { data, error } = await client.from("editions")
    .select("external_id, collections!inner(slug)")
    .eq("id", id)
    .maybeSingle()

  if (error || !data || !data.external_id || !data.collections?.slug) notFound()

  const coll = getCollectionByDbSlug(data.collections.slug)
  if (!coll) notFound()

  redirect(`/${coll.urlSlug}/edition/${encodeURIComponent(data.external_id)}`)
}
