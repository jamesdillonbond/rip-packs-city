// app/admin/storage-fix/page.tsx
//
// Trevor-only: diagnose a Flow account stuck on storage (error 1103) and send it the fix
// from his own Flow Wallet (2026-11-05). Server shell; the console is StorageFixClient.
// Token-gated per call against RPC_ADMIN_TOKEN (/api/admin/storage-fix). No public page.

import { Suspense } from "react"
import StorageFixClient from "./StorageFixClient"

export default function StorageFixPage() {
  return (
    <Suspense fallback={null}>
      <StorageFixClient />
    </Suspense>
  )
}
