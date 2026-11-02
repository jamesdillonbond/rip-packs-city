// app/trades/block/page.tsx
//
// Server shell. The surface lives in BlockBrowseClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.

import BlockBrowseClient from "./BlockBrowseClient";

export default function TradeBlockPage() {
  return <BlockBrowseClient />;
}
