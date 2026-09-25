// lib/profile/collector-identities.ts
//
// Non-address collector identities a user links to their profile — today, a
// Panini username. Stored in `saved_collector_identities` (migration
// 20260925233206), NOT in `saved_wallets`: a Panini owner is a USERNAME
// (lib/address.ts `isPaniniUsername`), and a username in `wallet_addr` would be
// handed to every chain-aware wallet helper as if it were an address.
//
// ⚠ A Panini username must NEVER reach the Top Shot resolver. The dashboard's
// one-field add sends any non-address string to /api/profile/resolve-and-
// associate, which resolves it on Top Shot — so a Panini handle that happens to
// match a Top Shot handle would attach SOMEONE ELSE'S Flow wallet. Panini gets
// its own explicit field and its own route (/api/profile/collector-identities).

import { isPaniniUsername } from "@/lib/address";

/**
 * Canonical stored form of a Panini username, or null when the input is not
 * one. Lowercased: `panini_card_serials.owner` is 71% mixed case and every read
 * matches on `lower(owner)`, and folding is collision-free (distinct(owner) ==
 * distinct(lower(owner)), verified 2026-08-08).
 */
export function normalizePaniniUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^@/, "");
  if (!isPaniniUsername(trimmed)) return null;
  return trimmed.toLowerCase();
}

/** What RPC can say about a Panini username (public.panini_owner_summary). */
export interface PaniniOwnerSummary {
  username: string;
  cards_seen: number;
  listed_now: number;
  special_serials: number;
  editions: number;
  last_seen_at: string | null;
}

/**
 * Parse the RPC payload. Returns null for anything that is not the expected
 * object — a malformed payload is a FAILED read, never "0 cards".
 */
export function parsePaniniOwnerSummary(data: unknown): PaniniOwnerSummary | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const cards = n(d.cards_seen);
  const listed = n(d.listed_now);
  const special = n(d.special_serials);
  const editions = n(d.editions);
  if (cards === null || listed === null || special === null || editions === null) return null;
  if (typeof d.username !== "string") return null;
  return {
    username: d.username,
    cards_seen: cards,
    listed_now: listed,
    special_serials: special,
    editions,
    last_seen_at: typeof d.last_seen_at === "string" ? d.last_seen_at : null,
  };
}

/**
 * How many identities this user has linked — they count toward the same
 * 5-per-user cap as saved wallets (Trevor, 2026-09-25).
 *
 * Returns `null` when the count could not be read. The wallet routes' cap check
 * is FAIL-OPEN by decision (2026-09-03), so a null there is treated as 0 and
 * logged; the identities route itself fails CLOSED on it.
 */
export async function countLinkedIdentities(supabase: any, userId: string): Promise<number | null> {
  let count: unknown;
  let error: { message?: string } | null = null;
  try {
    ({ count, error } = await supabase
      .from("saved_collector_identities")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId));
  } catch (err) {
    error = { message: err instanceof Error ? err.message : String(err) };
  }
  if (error || typeof count !== "number") {
    console.error(
      "[collector-identities] linked-identity count failed:",
      error?.message ?? "count was not a number"
    );
    return null;
  }
  return count;
}
