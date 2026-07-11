import type { CSSProperties } from "react"

// SpecialSerialGlyph — icon marking WHY a serial is special: first mint (#1),
// jersey match, or perfect serial (serial == last mint / #N/N).
//
// 2026-07-11 (Trevor-directed): renders the OFFICIAL platform badge art per
// collection — the same badges the v2 Top Shot / dapper.market moment pages
// show in their Special Serials section:
//   - Top Shot: exact inline SVGs from nbatopshot.com v2 (verified identical on
//     dapper.market/nba, moment 2149353). 12×12, currentColor — inherits pill color.
//   - NFL All Day: official badgesV3 CDN art (first-serial / player-number /
//     perfect-serial .svg) — the assets nflallday.com itself renders — proxied
//     through /api/badge-image?src=allday (full-color gradient art, not tintable).
//   - Anything else (Golazos/UFC/Pinnacle/unknown): original RPC-brand monoline
//     glyphs (medal / jersey / bullseye), currentColor.
//
// Accepts either tag vocabulary used across the app:
//   tag form:        "#1" | "jersey" | "last_mint" | "perfect"
//   badge_type enum: "first_serial" | "jersey_match" | "perfect_mint" | "last_serial"
// Collection accepts any slug form: nba-top-shot / nba_top_shot / topshot,
// nfl-all-day / nfl_all_day / allday. Returns null for unrecognized tags.

type Category = "first" | "jersey" | "perfect"

function categorize(tag: string | null | undefined): Category | null {
  const t = (tag ?? "").toLowerCase().trim()
  if (t === "#1" || t === "first" || t === "first_serial") return "first"
  if (t === "jersey" || t === "jersey_match") return "jersey"
  if (t === "perfect" || t === "last_mint" || t === "perfect_mint" || t === "last_serial") return "perfect"
  return null
}

type Platform = "topshot" | "allday" | null

function platformOf(collection: string | null | undefined): Platform {
  const c = (collection ?? "").toLowerCase().trim()
  if (c === "nba-top-shot" || c === "nba_top_shot" || c === "topshot") return "topshot"
  if (c === "nfl-all-day" || c === "nfl_all_day" || c === "allday") return "allday"
  return null
}

const ALLDAY_SLUG: Record<Category, string> = {
  first: "first-serial",
  jersey: "player-number",
  perfect: "perfect-serial",
}

export default function SpecialSerialGlyph({
  tag,
  size = 13,
  className = "",
  collection = null,
}: {
  tag: string | null | undefined
  size?: number
  className?: string
  collection?: string | null
}) {
  const cat = categorize(tag)
  if (!cat) return null

  const style: CSSProperties = { flex: "0 0 auto", display: "inline-block", verticalAlign: "middle" }
  const platform = platformOf(collection)

  if (platform === "allday") {
    // Official NFL All Day badge art (full-color; served same-origin via the
    // badge-image proxy — assets.nflallday.com needs a browser UA).
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={`/api/badge-image?src=allday&name=${ALLDAY_SLUG[cat]}`}
        width={size}
        height={size}
        className={className}
        style={style}
        alt=""
        aria-hidden="true"
      />
    )
  }

  if (platform === "topshot") {
    // Exact Top Shot v2 special-serial glyphs (12×12, currentColor).
    if (cat === "first") {
      return (
        <svg width={size} height={size} viewBox="0 0 12 12" className={className} style={style} aria-hidden="true" fill="none">
          <g clipPath="url(#rpcTsSsFirst)">
            <path d="M5.99156 9.59775L4.63256 8.2365L4.18875 8.68087L6.0045 10.5L7.81519 8.68538L7.35844 8.22806L5.99156 9.59775ZM8.68481 4.18538L8.2365 4.63481L9.59044 5.99156L8.21906 7.36631L8.68031 7.82756L10.5 6.00506L8.68481 4.18538ZM3.75112 4.63144L3.31069 4.18988L1.5 6.0045L3.31519 7.82362L3.768 7.36969L2.39269 5.99156L3.75112 4.63144ZM4.18425 3.32363L4.62019 3.76013L5.99156 2.38594L7.37138 3.768L7.81969 3.31912L6.0045 1.5L4.18425 3.32363Z" fill="currentColor" />
            <path d="M5.92524 8.35632L7.08286 7.19588V4.78782L5.92524 3.62738L3.56555 5.99213H4.92849L5.93255 4.95657L5.92524 5.99157V8.35632Z" fill="currentColor" />
          </g>
          <defs>
            <clipPath id="rpcTsSsFirst"><rect width="9" height="9" fill="currentColor" transform="translate(1.5 1.5)" /></clipPath>
          </defs>
        </svg>
      )
    }
    if (cat === "jersey") {
      return (
        <svg width={size} height={size} viewBox="0 0 12 12" className={className} style={style} aria-hidden="true" fill="none">
          <path d="M10 11H2V10H10V11ZM4.5 1C4.5 1.82843 5.17157 2.5 6 2.5C6.82843 2.5 7.5 1.82843 7.5 1H8.5V3.5C8.5 4.32843 9.17157 5 10 5V9H2V5C2.82843 5 3.5 4.32843 3.5 3.5V1H4.5Z" fill="currentColor" />
        </svg>
      )
    }
    // perfect / last mint
    return (
      <svg width={size} height={size} viewBox="0 0 12 12" className={className} style={style} aria-hidden="true" fill="none">
        <g clipPath="url(#rpcTsSsPerfect)">
          <path d="M5.96734 4.35638C5.75125 4.35999 5.53804 4.4065 5.34009 4.49322C5.14213 4.57993 4.96338 4.70512 4.81421 4.8615C4.66424 5.01682 4.54659 5.20037 4.46809 5.4015C4.38959 5.60263 4.35179 5.81734 4.3569 6.03319C4.36621 6.46879 4.54791 6.88292 4.86216 7.18472C5.17641 7.48652 5.59753 7.65136 6.03315 7.64306C6.2491 7.63945 6.46218 7.59299 6.66004 7.50637C6.85789 7.41976 7.03657 7.29472 7.18571 7.1385C7.48946 6.82182 7.65259 6.40613 7.64359 5.96681C7.63443 5.53111 7.45279 5.11685 7.13853 4.81492C6.82427 4.513 6.40306 4.34809 5.96734 4.35638Z" fill="currentColor" />
          <path d="M8.16114 3.81751C7.87481 3.53315 7.53507 3.30823 7.16147 3.1557C6.78787 3.00317 6.38779 2.92605 5.98426 2.92876C5.58093 2.9298 5.1818 3.01072 4.80991 3.16683C4.43802 3.32294 4.10073 3.55116 3.81751 3.83832C3.53315 4.12465 3.30823 4.46439 3.1557 4.83799C3.00317 5.21159 2.92605 5.61167 2.92876 6.0152C2.92988 6.4187 3.01093 6.81798 3.16724 7.18998C3.32355 7.56198 3.55202 7.89932 3.83945 8.18251C4.41375 8.75284 5.19063 9.07241 6.00001 9.07126H6.01576C6.41936 9.07022 6.81875 8.9892 7.19085 8.83289C7.56295 8.67658 7.90038 8.44807 8.18364 8.16057C8.468 7.87425 8.69291 7.53451 8.84544 7.16091C8.99797 6.78731 9.0751 6.38723 9.07239 5.9837C9.07087 5.58026 8.98963 5.1811 8.83335 4.80915C8.67706 4.43721 8.4488 4.09982 8.1617 3.81639M7.87764 7.85739C7.63404 8.10456 7.34388 8.30103 7.02393 8.43542C6.70397 8.56981 6.36055 8.63948 6.01351 8.64039H6.00001C5.30387 8.64182 4.63563 8.36688 4.14207 7.87595C3.89496 7.63242 3.69854 7.34235 3.56415 7.0225C3.42976 6.70264 3.36006 6.35933 3.35907 6.01239C3.35651 5.66533 3.42274 5.3212 3.55395 4.99989C3.68516 4.67857 3.87874 4.38645 4.12351 4.14039C4.36704 3.89327 4.65711 3.69685 4.97696 3.56246C5.29682 3.42807 5.64013 3.35837 5.98707 3.35739H6.00114C6.70145 3.35739 7.3607 3.62851 7.85907 4.12182C8.10619 4.36535 8.30261 4.65542 8.437 4.97528C8.57139 5.29513 8.64109 5.63844 8.64207 5.98539C8.64464 6.33245 8.5784 6.67657 8.4472 6.99789C8.31599 7.3192 8.1224 7.61133 7.87764 7.85739ZM10.1462 4.24839C10.0325 3.97954 9.8929 3.72239 9.72939 3.48057L9.41889 3.79107C9.7794 4.34828 9.99807 4.98524 10.0558 5.64638C10.1136 6.30752 10.0086 6.97274 9.7502 7.58401C9.65927 7.8006 9.54914 8.00862 9.42114 8.20557L9.73164 8.51607C10.2327 7.77265 10.5002 6.89651 10.5 6.00001C10.5011 5.39828 10.3808 4.80251 10.1462 4.24839ZM4.41601 2.24982C4.91719 2.038 5.45591 1.92934 6.00001 1.93032C6.78335 1.929 7.55026 2.15487 8.20782 2.58057L8.51832 2.27007C7.7749 1.76707 6.89761 1.49881 6.00001 1.50001C5.10168 1.49794 4.22354 1.76648 3.48001 2.27064L3.79051 2.58114C3.98864 2.45214 4.19799 2.34126 4.41601 2.24982ZM7.58457 9.7502C7.08322 9.96209 6.5443 10.0708 6.00001 10.0697C5.2178 10.071 4.45196 9.84572 3.79501 9.42114L3.48395 9.73164C4.22692 10.2336 5.10336 10.5013 6.00001 10.5C6.89929 10.502 7.77829 10.2329 8.52226 9.7277L8.21176 9.4172C8.01298 9.54689 7.80287 9.65835 7.58401 9.7502M1.93032 6.00001C1.92883 5.21673 2.15451 4.44983 2.58001 3.7922L2.26951 3.48114C1.7666 4.22478 1.49853 5.10228 1.50001 6.00001C1.49798 6.89929 1.76713 7.77829 2.27232 8.52226L2.58282 8.21176C2.1556 7.55332 1.92891 6.78491 1.93032 6.00001Z" fill="currentColor" />
        </g>
        <defs>
          <clipPath id="rpcTsSsPerfect"><rect width="9" height="9" fill="currentColor" transform="translate(1.5 1.5)" /></clipPath>
        </defs>
      </svg>
    )
  }

  // Fallback — original RPC-brand glyphs (Golazos / UFC / Pinnacle / unknown).
  if (cat === "first") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden="true"
           fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round">
        <circle cx="12" cy="9" r="6" />
        <path d="M9 14 L8 22 L12 19 L16 22 L15 14" />
        <circle cx="12" cy="9" r="2.1" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  if (cat === "jersey") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden="true"
           fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round">
        <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style} aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth={1.7}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
