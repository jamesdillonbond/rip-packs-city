// app/admin/giveaways/page.tsx
//
// Trevor-only console for community pack giveaways (v1: one admin). Server
// shell; the console is AdminGiveawaysClient. Token-gated per call against
// RPC_ADMIN_TOKEN (/api/admin/giveaways).

import AdminGiveawaysClient from "./AdminGiveawaysClient"

export default function AdminGiveawaysPage() {
  return <AdminGiveawaysClient />
}
