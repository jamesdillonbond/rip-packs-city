// app/admin/analytics/page.tsx
//
// Server shell. The whole surface lives in AdminAnalyticsClient so the COMPONENT
// coverage gate measures it — `app/**/page.tsx` matches neither gate's include, so
// every branch in this page was previously unmeasured however much logic it held.
// Behaviour is unchanged; this is a move.

import AdminAnalyticsClient from "./AdminAnalyticsClient";

export default function AdminAnalyticsPage() {
  return <AdminAnalyticsClient />;
}
