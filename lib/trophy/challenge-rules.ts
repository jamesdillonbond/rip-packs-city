// lib/trophy/challenge-rules.ts
//
// Server-side check that a pin into a CHALLENGE trophy case obeys that
// challenge's rules (trophy_challenges.rules). The first challenge is
// "Dame Time": Damian Lillard Top Shot Moments + Panini cards the collector
// holds.
//
// ⚠ EVERY INPUT HERE IS RESOLVED SERVER-SIDE, never taken from the request.
// The pin route's body carries a `playerName`, but a client can say anything;
// a challenge board where "Damian Lillard" is a request field is a board anyone
// can fill with anything. The player comes from the edition the moment resolves
// to (wallet_moments_cache.edition_key → editions.player_name), or, for Panini,
// from the card resolvePaniniTrophyCard verified against a linked username.
//
// ⚠ THREE OUTCOMES, not two (CLAUDE.md "Honesty"): eligible · NOT eligible (a
// 4xx with a reason the collector can act on) · COULD NOT CHECK (a failed read →
// a retryable 503 via apiErrorResponse). A failed read must never be reported as
// "that's not a Dame Moment".
//
// ⚠ A NAME IS NOT A PERSON (CLAUDE.md concierge rule 2). Matching is exact
// (case-insensitive, whitespace-collapsed) against the edition's own
// player_name, split on " | " for multi-player Panini cards — never a substring,
// so "Damian Lillard" cannot match a different player who shares a word.

import { PANINI_COLLECTION_ID } from "@/lib/trophy/slab-href";

export interface ChallengeRules {
  playerNames: string[];
  collectionSlugs: string[] | null;
  requireOwned: boolean;
}

/** Parse the stored jsonb, tolerating absent keys (absent = no constraint). */
export function parseChallengeRules(raw: unknown): ChallengeRules {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  const slugs = strs(r.collection_slugs);
  return {
    playerNames: strs(r.player_names),
    collectionSlugs: slugs.length > 0 ? slugs : null,
    requireOwned: r.require_owned === true,
  };
}

export function normalizeName(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Does an edition's player label name one of the challenge's players?
 * Multi-player Panini cards are labelled "A | B"; each part is a person.
 */
export function playerLabelMatches(label: string | null | undefined, playerNames: string[]): boolean {
  if (!label || playerNames.length === 0) return false;
  const wanted = new Set(playerNames.map(normalizeName));
  return label
    .split("|")
    .map(normalizeName)
    .some((part) => part.length > 0 && wanted.has(part));
}

/**
 * Main-case pins that LOOK eligible for a challenge — by player name only, the
 * client-side hint behind "Enter with my N Dame pieces" (2026-11-07). The
 * server re-checks every pin (ownership, collection) before copying; this only
 * decides whether to offer. Pieces already in the entry are not counted.
 */
export function mainCaseCandidates<T extends { player_name: string | null; moment_id: string }>(
  mainPins: T[] | null | undefined,
  rules: unknown,
  alreadyIn: ReadonlySet<string> = new Set(),
): T[] {
  if (!mainPins) return [];
  const { playerNames } = parseChallengeRules(rules);
  if (playerNames.length === 0) return [];
  return mainPins.filter((p) => !alreadyIn.has(p.moment_id) && playerLabelMatches(p.player_name, playerNames));
}

/** Human list for an error message: "Damian Lillard" / "A or B". */
export function describePlayers(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "this challenge's players";
  return names.slice(0, -1).join(", ") + " or " + names[names.length - 1];
}

export type ChallengeCheck =
  | { kind: "eligible" }
  | { kind: "ineligible"; status: number; error: string }
  | { kind: "unchecked"; error: unknown };

export interface ChallengePinInput {
  userId: string;
  momentId: string;
  collectionId: string;
  /** The Panini card's server-derived player label (null when not Panini). */
  paniniPlayerName: string | null;
}

/**
 * Check one pin against one challenge's rules. `db` is the service-role client.
 */
export async function checkChallengePin(
  db: any,
  rules: ChallengeRules,
  challengeTitle: string,
  input: ChallengePinInput
): Promise<ChallengeCheck> {
  try {
    // ── Collection ──────────────────────────────────────────────────────────
    if (rules.collectionSlugs) {
      const col = await db.from("collections").select("slug").eq("id", input.collectionId).limit(1);
      if (col.error) return { kind: "unchecked", error: col.error };
      const slug = (col.data?.[0]?.slug as string | undefined) ?? null;
      if (!slug || !rules.collectionSlugs.includes(slug)) {
        return {
          kind: "ineligible",
          status: 422,
          error: `${challengeTitle} only takes pieces from its own collections.`,
        };
      }
    }

    if (rules.playerNames.length === 0) return { kind: "eligible" };
    const who = describePlayers(rules.playerNames);

    // ── Panini: the card was already verified as held under a linked username
    // by resolvePaniniTrophyCard (the route 403s before reaching here if not).
    if (input.collectionId === PANINI_COLLECTION_ID) {
      return playerLabelMatches(input.paniniPlayerName, rules.playerNames)
        ? { kind: "eligible" }
        : { kind: "ineligible", status: 422, error: `${challengeTitle} is ${who} only — that card isn't one.` };
    }

    // ── Flow / Solana: resolve the moment through the wallet index ──────────
    let wallets: string[] | null = null;
    if (rules.requireOwned) {
      const sw = await db.from("saved_wallets").select("wallet_addr").eq("user_id", input.userId);
      if (sw.error) return { kind: "unchecked", error: sw.error };
      wallets = ((sw.data ?? []) as { wallet_addr: unknown }[])
        .map((r) => (typeof r.wallet_addr === "string" ? r.wallet_addr : null))
        .filter((w): w is string => w != null);
      if (wallets.length === 0) {
        return {
          kind: "ineligible",
          status: 403,
          error: `${challengeTitle} only takes pieces you hold — add your wallet to your profile first.`,
        };
      }
    }

    let q = db
      .from("wallet_moments_cache")
      .select("edition_key")
      .eq("moment_id", input.momentId)
      .eq("collection_id", input.collectionId)
      .not("edition_key", "is", null)
      .limit(1);
    if (wallets) q = q.in("wallet_address", wallets);
    const wmc = await q;
    if (wmc.error) return { kind: "unchecked", error: wmc.error };
    const editionKey = (wmc.data?.[0]?.edition_key as string | undefined) ?? null;
    if (!editionKey) {
      return rules.requireOwned
        ? {
            kind: "ineligible",
            status: 403,
            error: `${challengeTitle} only takes pieces you hold, and that one isn't in your saved wallets.`,
          }
        : { kind: "ineligible", status: 422, error: `We couldn't identify that Moment's player.` };
    }

    const ed = await db
      .from("editions")
      .select("player_name")
      .eq("collection_id", input.collectionId)
      .eq("external_id", editionKey)
      .limit(1);
    if (ed.error) return { kind: "unchecked", error: ed.error };
    const label = (ed.data?.[0]?.player_name as string | undefined) ?? null;
    if (label == null) {
      // The edition row is missing — we cannot say whose Moment it is, so we
      // say that rather than "it isn't Dame".
      return { kind: "ineligible", status: 422, error: `We couldn't identify that Moment's player yet.` };
    }
    return playerLabelMatches(label, rules.playerNames)
      ? { kind: "eligible" }
      : { kind: "ineligible", status: 422, error: `${challengeTitle} is ${who} only — that Moment is ${label}.` };
  } catch (error) {
    return { kind: "unchecked", error };
  }
}
