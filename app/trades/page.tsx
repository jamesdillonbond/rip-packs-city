// app/trades/page.tsx
//
// Server shell. The surface lives in TradesListClient so the COMPONENT coverage
// gate measures it — `app/**/page.tsx` matches neither gate's include.

import TradesListClient from "./TradesListClient";

export default function TradesPage() {
  return <TradesListClient />;
}
