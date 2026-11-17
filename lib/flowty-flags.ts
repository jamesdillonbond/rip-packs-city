// Three-flag Flowty kill-switch.
//
// FLOWTY_MARKETPLACE_ENABLED — gates user-facing buy paths. NEXT_PUBLIC_ so the
//   client bundle can read it directly without an extra round-trip. Defaults to
//   false so the marketplace is OFF unless Trevor explicitly turns it on.
//
// FLOWTY_LOANS_ENABLED / FLOWTY_INGEST_ENABLED — server-only. Default to true
//   (i.e. enabled when unset) so loans + listing-data ingestion keep working
//   automatically. Trevor only flips these to "false" if Flowty's read APIs
//   start failing too.

export const FLOWTY_MARKETPLACE_ENABLED: boolean =
  process.env.NEXT_PUBLIC_FLOWTY_MARKETPLACE_ENABLED === "true";

export function isFlowtyLoansEnabled(): boolean {
  return process.env.FLOWTY_LOANS_ENABLED !== "false";
}

export function isFlowtyIngestEnabled(): boolean {
  return process.env.FLOWTY_INGEST_ENABLED !== "false";
}

export const FLOWTY_MARKETPLACE_DISABLED_MESSAGE =
  "Flowty marketplace temporarily unavailable";

export const FLOWTY_INCIDENT_URL =
  "https://flowty.substack.com/p/announcement-suspension-of-flowty";
