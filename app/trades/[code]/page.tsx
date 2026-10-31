// app/trades/[code]/page.tsx
//
// Server shell for one trade room. The surface lives in TradeRoomClient so the
// COMPONENT coverage gate measures it.

import TradeRoomClient from "./TradeRoomClient";

type Ctx = { params: Promise<{ code: string }> };

export default async function TradeRoomPage({ params }: Ctx) {
  const { code } = await params;
  return <TradeRoomClient code={code} />;
}
