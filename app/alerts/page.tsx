// app/alerts/page.tsx
//
// Server shell. The surface lives in AlertsClient so the COMPONENT coverage gate measures
// it — `app/**/page.tsx` matches neither gate's include.
//
// Already CLEAN on the failed-read sweep, and unusually thoroughly: failure is tracked PER
// LEG (channels / subscriptions / FMV alerts), because every empty state on this page is a
// claim about the READER'S OWN account ("No alerts yet", "not linked") and one shared flag
// would blank all three whenever any one of them hiccuped. This is coverage, not a fix.

import AlertsClient from "./AlertsClient";

export default function AlertsPage() {
  return <AlertsClient />;
}
