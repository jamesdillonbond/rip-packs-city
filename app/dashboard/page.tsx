// app/dashboard/page.tsx
// Server shell. Behaviour lives in DashboardClient.tsx so the component
// coverage gate measures it — a `page.tsx` is in neither gate's include, so
// ~2,545 lines (the largest client page in the repo) were unmeasured by
// construction, including every honesty branch this page has accumulated:
// `meFailed`, `statsFailed`, the hero-picker's `loadFailed`, and the trophy
// reorder's optimistic-rollback path.

import DashboardClient from "./DashboardClient";

export default function ProfilePage() {
  return <DashboardClient />;
}
