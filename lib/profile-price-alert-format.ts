// Pure label/formatting helpers lifted out of
// components/profile/PriceAlertsCard.tsx so the coverage ratchet (which only
// measures lib/** + app/api/**/route.ts) can pin them. Behavior copied verbatim
// from the component; a regression here mis-describes an alert's trigger
// condition or mis-labels when it last fired.
import { fmtDollars } from "@/components/profile/_shared";

// Human-readable description of an alert's trigger condition. The default arm
// covers any alert_type the switch doesn't recognize.
export function describeAlert(alert_type: string, threshold: number): string {
  switch (alert_type) {
    case "below_price":
      return "Lowest ask drops to or below " + fmtDollars(Number(threshold));
    case "below_fmv_pct":
      return "Discount vs FMV exceeds " + threshold + "%";
    case "below_fmv":
      return "FMV drops below " + fmtDollars(Number(threshold));
    case "above_fmv":
      return "FMV rises above " + fmtDollars(Number(threshold));
    default:
      return alert_type + " ≥ " + threshold;
  }
}

// Coarse relative-time label for when an alert last triggered. `now` is
// injectable so the branch logic is deterministically testable; the component
// always calls it with the default (Date.now()). The final arm returns a
// locale-formatted absolute date.
export function formatAlertWhen(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  const diff = now - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "Today";
  if (diff < 2 * day) return "Yesterday";
  if (diff < 7 * day) return Math.floor(diff / day) + "d ago";
  return d.toLocaleDateString();
}
