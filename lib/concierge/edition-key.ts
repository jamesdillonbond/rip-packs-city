// Concierge edition-key ↔ collection vocabulary guard.
//
// Extracted from app/api/support-chat/route.ts so this pure check can be
// unit-tested. It enforces the CLAUDE.md footgun that the two collections use
// incompatible edition-key shapes: Top Shot keys are numeric `setID:playID`
// (e.g. "73:2785"); Disney Pinnacle uses opaque string keys. Passing a key of
// the wrong shape for the active collection silently mis-queries, so the
// concierge returns a `wrong_collection` warning to the model instead.
//
// No DB, no network — pure string inspection. The route wraps the return value
// in JSON.stringify to hand it back to the model; behavior is unchanged.

import { isPinnacle } from "@/lib/concierge/pinnacle-router"

export type EditionKeyMismatch = {
  status: "wrong_collection"
  message: string
}

// TopShot edition keys are `<setID>:<playID>`, both integers.
const TOPSHOT_KEY_SHAPE = /^\d+:\d+$/

export function editionKeyCollectionMismatch(
  key: unknown,
  collectionId: string | null | undefined
): EditionKeyMismatch | null {
  if (!key || typeof key !== "string" || !collectionId) return null
  const looksLikeTopShot = TOPSHOT_KEY_SHAPE.test(key)

  if (collectionId === "nba-top-shot" && !looksLikeTopShot) {
    return {
      status: "wrong_collection",
      message: `Edition key '${key}' doesn't match the Top Shot setID:playID format. Provide playerName instead, or check the active collection.`,
    }
  }
  if (isPinnacle(collectionId) && looksLikeTopShot) {
    return {
      status: "wrong_collection",
      message:
        "That edition key shape (setID:playID) belongs to Top Shot. Disney Pinnacle uses opaque edition_key strings.",
    }
  }
  return null
}
