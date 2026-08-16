// app/dashboard/alerts/page.tsx
//
// Server shell. The surface lives in DashboardAlertsClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.
//
// Already CLEAN on the failed-read sweep: the welcome/"No alerts yet" card is gated on
// `!err`, added after a collector whose read 503'd was shown a confident "you have none"
// directly beneath the error banner — an invitation to create a DUPLICATE of an alert they
// already had. This is coverage, not a fix.

import DashboardAlertsClient from "./DashboardAlertsClient";

export default function AlertsPage() {
  return <DashboardAlertsClient />;
}
