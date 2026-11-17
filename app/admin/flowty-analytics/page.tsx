// app/admin/flowty-analytics/page.tsx
// Server shell. Every line of behaviour lives in FlowtyAnalyticsClient.tsx so
// the component coverage gate measures it; a `page.tsx` is in neither gate's
// include, which is why this dashboard's charts and leaderboards went
// unmeasured for as long as they did.

import FlowtyAnalyticsClient from "./FlowtyAnalyticsClient";

export default function FlowtyAnalyticsPage() {
  return <FlowtyAnalyticsClient />;
}
