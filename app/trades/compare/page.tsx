// app/trades/compare/page.tsx
//
// Server shell. The surface lives in CompareClient so the COMPONENT coverage gate measures it
// (`app/**/page.tsx` matches neither gate's include). Suspense: the client reads ?u1/?u2.

import { Suspense } from "react";
import CompareClient from "./CompareClient";

export default function TradeComparePage() {
  return (
    <Suspense fallback={null}>
      <CompareClient />
    </Suspense>
  );
}
