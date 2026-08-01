// Pure formatters/URL-builders for the special-serial-owners board
// (app/special-serial-owners/page.tsx — a ~450-line client neither coverage gate
// measures). Bodies are byte-identical to the originals; the page imports these.

export function fmtMoney(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}

export function fmtInt(n: number | null): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}

export function truncAddr(a: string | null): string {
  if (!a) return "—"
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
}

export function tierColor(tier: string | null): string {
  switch ((tier ?? "").toUpperCase()) {
    case "LEGENDARY": return "var(--tier-legendary)"
    case "ULTIMATE": return "var(--tier-ultimate)"
    case "RARE": return "var(--tier-rare)"
    case "FANDOM": return "var(--tier-fandom)"
    case "UNCOMMON": return "var(--tier-rare)" // AllDay Uncommon — reuse the rare hue
    case "COMMON": return "var(--tier-common)"
    default: return "var(--rpc-text-muted)"
  }
}

export function tagLabel(tag: string | null): string {
  if (tag === "#1") return "#1 MINT"
  if (tag === "perfect") return "PERFECT"
  if (tag === "jersey") return "JERSEY"
  return (tag ?? "").toUpperCase()
}

/** Minimal row shape the serial/href/image builders read. */
export interface OwnerRowLike {
  serial: number | null
  circulation_count?: number | null
  edition_key?: string | null
  nft_id?: string | null
}

/** "#serial / circulation" when circulation is known, else "#serial". */
export function serialLabel(r: OwnerRowLike): string {
  if (r.circulation_count != null) return `#${fmtInt(r.serial)} / ${fmtInt(r.circulation_count)}`
  return `#${fmtInt(r.serial)}`
}

export function editionHref(r: OwnerRowLike, collection: string): string | null {
  if (!r.edition_key) return null
  return `/${collection}/edition/${encodeURIComponent(r.edition_key)}`
}

/** Moment art URL — AllDay art is edition-keyed, everything else nft-keyed. */
export function momentImg(r: OwnerRowLike, collection: string): string | null {
  if (collection === "nfl-all-day") {
    // AllDay art is edition-keyed (external_id == editionID), not nft-keyed.
    if (!r.edition_key) return null
    return `https://media.nflallday.com/editions/${encodeURIComponent(r.edition_key)}/media/image?width=384&format=webp&quality=90`
  }
  if (!r.nft_id) return null
  return `https://assets.nbatopshot.com/media/${encodeURIComponent(r.nft_id)}/image?width=384`
}
