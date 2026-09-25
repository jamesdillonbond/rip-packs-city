// app/teams/layout.tsx — the page frame for /teams and every /teams/<league>/<slug> hub.
//
// 2026-09-25: the hub pages (09-23) and the new directory rendered a bare
// <div> under the root layout — no gutter, no max width — so on a phone the
// breadcrumb, title and cards sat flush against the left edge, and on a
// desktop the grid ran the full window width. The per-collection pages get
// this frame from app/(collections)/[collection]/layout.tsx; /moment/[id]
// carries its own <main>. This is the same frame, once, for the /teams tree.

import type { ReactNode } from "react"

export default function TeamsLayout({ children }: { children: ReactNode }) {
  return (
    <main
      className="rpc-main"
      style={{
        minHeight: "60vh",
        maxWidth: 1200,
        margin: "0 auto",
        padding: "24px 16px 80px",
      }}
    >
      {children}
    </main>
  )
}
