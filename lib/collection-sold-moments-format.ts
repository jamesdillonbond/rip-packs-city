// Pure formatting / filtering / aggregation helpers lifted out of
// components/collection/WalletSoldMomentsView.tsx so the coverage ratchet (which
// only measures lib/** + app/api/**/route.ts) can pin them. Behavior copied
// verbatim from the component; a regression here mis-labels sale amounts / dates
// / buyer addresses, leaks another collection's sales onto the "Sold" board, or
// mis-computes the total-proceeds tile and the truncation banner.

// USD amount for a sale, or an em-dash when unknown. Matches the component's
// two-decimal en-US grouping exactly.
export function fmtSoldUsd(n: number | null | undefined): string {
  if (n == null) return "—";
  return (
    "$" +
    Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

// Coarse relative-time label for a sale timestamp. `now` is injectable so the
// branch logic is deterministically testable; the component always calls it with
// the default (Date.now()).
export function relativeSaleTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const days = Math.floor((now - then) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// Truncated 0x… address for the buyer/counterparty column.
export function shortSellerAddr(a: string | null): string {
  if (!a) return "—";
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// Client-side collection filter (the transaction-history RPC takes no collection
// param). Accepts either identifier form (DB slug or the raw route prop) and
// TRIMs the event value so a slug-form or whitespace mismatch can't drop every
// real row. When the collection is unresolvable (dbSlug null) it falls back to
// showing everything, matching the component's documented behavior.
export function filterSoldEventsByCollection<T extends { collection_slug: string | null }>(
  events: T[],
  dbSlug: string | null,
  collection: string,
): T[] {
  if (!dbSlug) return events;
  const accept = new Set([dbSlug, collection]);
  return events.filter((e) => accept.has((e.collection_slug ?? "").trim()));
}

// Total USD proceeds across the (already collection-filtered) sold rows.
export function sumSoldProceeds(rows: Array<{ amount_usd: number | null }>): number {
  return rows.reduce((sum, r) => sum + (Number(r.amount_usd) || 0), 0);
}

// Whether the wallet's lifetime sale count exceeds the single fetched page, which
// drives the "showing the N most recent" disclosure banner.
export function isSoldListTruncated(
  totalCount: number | null | undefined,
  fetchLimit: number,
): boolean {
  return (totalCount ?? 0) > fetchLimit;
}
