// app/(collections)/[collection]/market/page.tsx
// Server shell. Behaviour lives in MarketClient.tsx so the component coverage
// gate measures it — a `page.tsx` is in neither gate's include, so ~1,170 lines
// of filter, sort, pagination and listing-render logic were unmeasured.

import MarketClient from "./MarketClient";

export default function MarketPage() {
  return <MarketClient />;
}
