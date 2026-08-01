// Pure formatters for the pack-lifecycle client
// (app/(collections)/[collection]/pack/[id]/PackLifecycleClient.tsx — a
// ~1,160-line client component that had ZERO lib imports, so none of these were
// measured by either coverage gate). Bodies are byte-identical to the originals;
// the component imports them.

export function shortAddr(addr: string | null | undefined): string {
  if (!addr) return "—"
  const a = addr.trim()
  if (a.length <= 10) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—"
  const h = hash.trim()
  if (h.length <= 12) return h
  return `${h.slice(0, 8)}…${h.slice(-6)}`
}

export function flowscanTxUrl(hash: string): string {
  return `https://www.flowscan.io/tx/${encodeURIComponent(hash)}`
}

export function flowscanAccountUrl(addr: string): string {
  return `https://www.flowscan.io/account/${encodeURIComponent(addr)}`
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const diffSec = Math.max(0, (Date.now() - t) / 1000)
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 30 * 86_400) return `${Math.floor(diffSec / 86_400)}d ago`
  if (diffSec < 365 * 86_400) return `${Math.floor(diffSec / (30 * 86_400))}mo ago`
  return `${Math.floor(diffSec / (365 * 86_400))}y ago`
}

/** Whole-dollar amounts drop the trailing ".00" so headlines read "$20" rather
 *  than "$20.00". Sub-dollar amounts keep two decimals. */
export function fmtUsd(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—"
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return "—"
  if (v === Math.trunc(v)) {
    return `$${v.toLocaleString("en-US")}`
  }
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function fmtPrice(n: number | string | null | undefined, currency: string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—"
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return "—"
  const formatted = v.toLocaleString("en-US", { maximumFractionDigits: 4 })
  return currency ? `${formatted} ${currency}` : formatted
}

/** DUC is 1:1 USD-pegged, so we render DUC amounts as plain USD and drop the
 *  "DUC" suffix entirely — every observed Top Shot pack pays in DUC and the
 *  parenthetical doubles up on the same number. Non-DUC currencies (FLOW,
 *  USDC, etc.) keep their suffix so the unit isn't lost. */
export function fmtPriceWithUsd(
  n: number | string | null | undefined,
  currency: string | null | undefined,
): string {
  if (n === null || n === undefined || n === "") return "—"
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return "—"
  if (currency && currency.toUpperCase() === "DUC") {
    return fmtUsd(v)
  }
  return fmtPrice(v, currency)
}

/** "Dec 2022" style month-year for the distribution metadata strip. */
export function formatMonthYear(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" })
}

/** Rewrite a Top Shot CDN /editions/ thumbnail URL through the resize endpoint
 *  so the browser fetches an already-optimized webp at the requested width.
 *  The raw Hero_2880_2880_Transparent.png is ~2880px square (multi-MB) —
 *  rendering it directly into a ~220px card is why pull thumbnails look fuzzy.
 *  Non-Top-Shot CDN URLs pass through unchanged. */
export function resizedThumb(url: string | null | undefined, width: number = 900): string | null {
  if (!url) return null
  if (url.includes("assets.nbatopshot.com/editions/")) {
    const resized = url.replace(
      "assets.nbatopshot.com/editions/",
      "assets.nbatopshot.com/resize/editions/",
    )
    return `${resized}?format=webp&quality=80&width=${width}`
  }
  return url
}
