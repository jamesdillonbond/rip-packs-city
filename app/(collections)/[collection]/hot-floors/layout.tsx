import type { Metadata } from "next"
import type { ReactNode } from "react"
import { getCollection } from "@/lib/collections"
import { foldedTabCanonical, unknownCollectionMetadata } from "@/lib/seo"
import FeatureTabGate from "@/components/collection/FeatureTabGate"

// Folded tab (2026-07-18 IA reorg) — deliberately has NO `PAGE_META` entry, so
// it does NOT self-canonicalise like its seven siblings. Promoting it would put
// it in query competition with its own parent. This layout exists only to fix
// the TARGET of that consolidation: before 2026-08-21 the absent layout meant
// the page inherited `collectionLayoutMetadata()` and pointed `canonical` at
// the collection root, which is AUTH-GATED (verified live: `GET /nba-top-shot`
// -> `x-matched-path: /login`). See `FOLDED_TAB_PARENT` in lib/seo.ts.
//
// ⚠ Only `alternates` is returned. Every other key (title, description,
// openGraph, twitter) is intentionally left to the parent
// `[collection]/layout.tsx` — Next merges page metadata at the TOP-LEVEL key
// only, so returning a partial object here replaces `alternates` alone and
// leaves the rest inherited, which is exactly the intent for a folded surface.
export async function generateMetadata(
  props: { params: Promise<{ collection: string }> }
): Promise<Metadata> {
  const { collection: id } = await props.params
  const collection = getCollection(id)
  if (!collection) return unknownCollectionMetadata("hot-floors", id)
  return { alternates: { canonical: foldedTabCanonical("hot-floors", collection.id) } }
}

// ⚠ The gate is the second half of the same omission. `FeatureTabGate` was
// built in the SAME 2026-07-18 reorg so "a direct URL to a tab a collection
// doesn't expose renders a graceful pointer instead of a broken/empty core
// tab" — and these three folded tabs were the ones it never got applied to.
// Measured 2026-08-21: 11 anon-public URLs (e.g. /ufc/challenges, which UFC
// does not ship) rendered the raw tab. It is a transparent pass-through
// whenever the collection DOES expose the page, so the tabs that legitimately
// ship it are unaffected.
export default async function FoldedTabLayout(
  props: { children: ReactNode; params: Promise<{ collection: string }> }
) {
  const { collection: id } = await props.params
  return <FeatureTabGate id={id} page="hot-floors">{props.children}</FeatureTabGate>
}
