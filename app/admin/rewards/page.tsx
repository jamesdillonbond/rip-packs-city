// app/admin/rewards/page.tsx
//
// Server shell. The console lives in AdminRewardsClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.
//
// This page was already CLEAN on the failed-read sweep (it carries an explicit
// `loadFailed` distinct from "the lists are empty"), so this is coverage, not a fix.

import AdminRewardsClient from "./AdminRewardsClient";

export default function AdminRewardsPage() {
  return <AdminRewardsClient />;
}
