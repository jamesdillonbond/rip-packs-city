// lib/hooks/useCollectionContext.ts
//
// Canonical client-side access to the active collection. Every
// collection-scoped page should consume this hook instead of deriving
// state from useParams + a Record lookup. Consolidates: the Collection
// object, accent colors, the Supabase UUID, a hasPage predicate, and
// marketplace URL builders pre-bound to the active collection id.

"use client"

import { useParams } from "next/navigation"
import { useMemo } from "react"
import {
  getCollection,
  marketplaceMomentUrl,
  marketplaceWalletUrl,
  publishedCollections,
  type Collection,
  type CollectionPage,
} from "@/lib/collections"

export interface CollectionContext {
  /** The active collection, or null if the URL segment doesn't match. */
  collection: Collection | null
  /** Slug id (e.g. "nba-top-shot"). Falls back to first published if absent. */
  collectionId: string
  /** Whether this collection is in the published set. */
  published: boolean
  /** Primary accent color. Always returns a value (POR red fallback). */
  accent: string
  /** Softer hover/secondary accent. Falls back to accent. */
  accentSoft: string
  /** Supabase collections.id UUID. null for unknown / unseeded collections. */
  supabaseCollectionId: string | null
  /** True if the given page is enabled in the collection's pages array. */
  hasPage: (page: CollectionPage) => boolean
  /** Marketplace moment URL pre-bound to the active collection. null if no template. */
  momentUrl: (flowId: string) => string | null
  /** Marketplace wallet URL pre-bound to the active collection. null if no template. */
  walletUrl: (address: string) => string | null
}

/**
 * Read the active collection from the URL's [collection] segment. Use only
 * inside pages/components that live under app/(collections)/[collection]/.
 */
export function useCollectionContext(): CollectionContext {
  const params = useParams()
  const rawId = (params?.collection as string) ?? ""
  return useMemo(() => buildContext(rawId), [rawId])
}

/** Variant for when the collection id is passed explicitly (layouts, server components). */
export function getCollectionContext(collectionId: string): CollectionContext {
  return buildContext(collectionId)
}

function buildContext(rawId: string): CollectionContext {
  const collection = getCollection(rawId) ?? null
  const fallback = publishedCollections()[0]
  const effectiveId = collection?.id ?? fallback?.id ?? "nba-top-shot"
  const accent = collection?.accent ?? "#E03A2F"
  const accentSoft = collection?.accentSoft ?? accent
  const enabled = new Set<CollectionPage>(collection?.pages ?? [])

  return {
    collection,
    collectionId: effectiveId,
    published: collection?.published ?? false,
    accent,
    accentSoft,
    supabaseCollectionId: collection?.supabaseCollectionId ?? null,
    hasPage: (page) => enabled.has(page),
    momentUrl: (flowId: string) => marketplaceMomentUrl(effectiveId, flowId),
    walletUrl: (address: string) => marketplaceWalletUrl(effectiveId, address),
  }
}
