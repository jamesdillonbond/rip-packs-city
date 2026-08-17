// app/admin/feedback/page.tsx
// Server shell. Behaviour lives in AdminFeedbackClient.tsx so the component
// coverage gate measures it — a `page.tsx` is in neither gate's include.

import AdminFeedbackClient from "./AdminFeedbackClient";

export default function AdminFeedbackPage() {
  return <AdminFeedbackClient />;
}
