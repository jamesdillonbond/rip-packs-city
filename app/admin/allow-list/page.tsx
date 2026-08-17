// app/admin/allow-list/page.tsx
//
// Server shell. The console lives in AdminAllowListClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.

import AdminAllowListClient from "./AdminAllowListClient";

export default function AdminAllowListPage() {
  return <AdminAllowListClient />;
}
