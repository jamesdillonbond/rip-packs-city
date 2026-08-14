// lib/cosmetics.ts
//
// Shared, client-safe cosmetic style maps for the rewards profile cosmetics
// (Profile Border / Profile Banner). Pure data + lookup helpers — NO server
// imports, so this can be used from both server components/routes and "use
// client" components.
//
// The string keys mirror shop_items.metadata.value for cosmetic SKUs and the
// values stored in profile_bio.equipped_border / equipped_banner +
// user_cosmetics.value. An unknown/null value resolves to null (no decoration)
// so a future cosmetic SKU never throws here before its style is added.

export interface BorderCosmetic {
  /** Ring color applied around the avatar. */
  ring: string;
  /** Optional outer glow (box-shadow color). */
  glow?: string;
  label: string;
}

export interface BannerCosmetic {
  /** CSS background applied to the profile header banner strip. */
  background: string;
  label: string;
}

export const BORDER_COSMETICS: Record<string, BorderCosmetic> = {
  classic: { ring: "#C9A227", glow: "rgba(201,162,39,0.45)", label: "Classic" },
  flame: { ring: "#FF6A2C", glow: "rgba(255,106,44,0.55)", label: "Flame" },
  // Wave 2 — icy cyan; cool counterpoint to the warm classic/flame rings.
  ice: { ring: "#7FD8FF", glow: "rgba(127,216,255,0.55)", label: "Ice" },
  // Wave 2 — bright metallic gold, deliberately brighter than the muted classic.
  gold: { ring: "#FFD24A", glow: "rgba(255,210,74,0.6)", label: "Gold" },
};

export const BANNER_COSMETICS: Record<string, BannerCosmetic> = {
  ripcity: {
    // brand-exception: cosmetic banner gradient data (mixed non-token hexes)
    background: "linear-gradient(110deg, #141414 0%, #3a0b08 48%, #E03A2F 100%)",
    label: "Rip City",
  },
  // Wave 2 — supernova nebula sweep; distinct from the red Rip City banner.
  nova: {
    background: "linear-gradient(120deg, #1a0b2e 0%, #4a1d6e 45%, #b3308f 80%, #ff7eb3 100%)",
    label: "Supernova",
  },
};

// Own-property guard: a bare `MAP[value]` read matches inherited
// Object.prototype members, so a stored value of "toString" / "constructor"
// would return a prototype member (a truthy function) instead of null, yielding
// a phantom cosmetic whose ring/label are undefined. `value` mirrors
// user-writable profile_bio.equipped_border / user_cosmetics.value, so guard it.
function ownValue<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function borderCosmetic(value: string | null | undefined): BorderCosmetic | null {
  if (!value) return null;
  return ownValue(BORDER_COSMETICS, value) ?? null;
}

export function bannerCosmetic(value: string | null | undefined): BannerCosmetic | null {
  if (!value) return null;
  return ownValue(BANNER_COSMETICS, value) ?? null;
}

/**
 * Can this app actually DRAW the cosmetic identified by (slot, value)?
 *
 * ⚠ The catalogue has TWO halves that are joined by nothing. A cosmetic SKU is a
 * row in `shop_items` (`metadata: {slot, value}`) — a pure DB insert, no deploy —
 * while its appearance is the maps above, which ship with the bundle. Nothing
 * checks that a sold SKU has a style, and the lookups above fail SOFT by design
 * (an unknown value resolves to `null` rather than throwing), so the failure is
 * silent all the way down: a collector spends credits, equips it, and their
 * public profile is unchanged with no error anywhere. The owned-cosmetics tile
 * even drew a grey placeholder that reads as a legitimately dark cosmetic.
 *
 * So the two surfaces ASK this before offering the SKU. It also makes the
 * ordering safe in both directions — ship the row first and it is simply not for
 * sale until the style lands, rather than being sellable and inert.
 *
 * Returns false for an unknown slot: a cosmetic we cannot classify is one we
 * cannot render either, and defaulting to "sellable" is the wrong way to be
 * wrong when credits change hands.
 */
export function hasCosmeticStyle(
  slot: string | null | undefined,
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  if (slot === "border") return borderCosmetic(value) !== null;
  if (slot === "banner") return bannerCosmetic(value) !== null;
  return false;
}
