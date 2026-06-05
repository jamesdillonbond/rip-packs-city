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
};

export const BANNER_COSMETICS: Record<string, BannerCosmetic> = {
  ripcity: {
    background: "linear-gradient(110deg, #141414 0%, #3a0b08 48%, #E03A2F 100%)",
    label: "Rip City",
  },
};

export function borderCosmetic(value: string | null | undefined): BorderCosmetic | null {
  if (!value) return null;
  return BORDER_COSMETICS[value] ?? null;
}

export function bannerCosmetic(value: string | null | undefined): BannerCosmetic | null {
  if (!value) return null;
  return BANNER_COSMETICS[value] ?? null;
}
