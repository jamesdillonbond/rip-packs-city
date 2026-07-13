// app/dashboard/gift/page.tsx
//
// Parent-signed Top Shot gifting (Phase 1). Auth is enforced by proxy.ts
// (allow-listed users only); the gift itself is gated on the user's own wallet
// signature — RPC never holds keys. See
// docs/design/parent-signed-gifting-fcl-flow-2026-07-13.md.

import type { Metadata } from "next";
import GiftClient from "./GiftClient";

export const metadata: Metadata = {
  title: "Gift a Moment",
  description: "Send a Top Shot moment out of your linked account to any Dapper or Flow wallet.",
  robots: { index: false, follow: false },
};

export default function GiftPage() {
  return <GiftClient />;
}
