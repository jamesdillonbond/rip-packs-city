// app/trades/block/mine/page.tsx
//
// My Trade Block — signed in (the proxy sends anon callers to /login). Server shell; the
// surface lives in BlockMineClient so the COMPONENT coverage gate measures it.

import type { Metadata } from "next";
import BlockMineClient from "./BlockMineClient";

export const metadata: Metadata = {
  title: "My Trade Block",
  robots: { index: false, follow: false },
  alternates: { canonical: "/trades/block/mine" },
};

export default function MyTradeBlockPage() {
  return <BlockMineClient />;
}
