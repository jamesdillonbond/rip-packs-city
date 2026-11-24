// lib/panini/username-storage.ts
//
// The localStorage slot that remembers the Panini username a visitor last looked up. The Collection tab
// (components/collection/PaniniCollection.tsx) writes it; the player checklist
// (components/panini/PaniniPlayerChecklist.tsx, 2026-11-23) reads and writes the same slot, so a username entered
// in either place carries over. Remembering is a convenience — no read depends on it.
import { isPaniniUsername } from "@/lib/address"

export const PANINI_USERNAME_STORAGE_KEY = "rpc.panini.collection.username"


/**
 * The same normalisation as lib/profile/collector-identities.ts normalizePaniniUsername (trim, drop a leading
 * "@", validate, lowercase) — kept here so a CLIENT component can use it without importing that module, whose
 * other exports read the database (scripts/check-unbounded-server-reads.mjs traces page imports through it).
 */
export function normalizePaniniUsernameClient(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().replace(/^@/, "")
  if (!isPaniniUsername(trimmed)) return null
  return trimmed.toLowerCase()
}
