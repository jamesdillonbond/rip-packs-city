// app/(collections)/[collection]/analytics/page.tsx
// Server shell. Behaviour lives in CollectionAnalyticsClient.tsx so the
// component coverage gate measures it — a `page.tsx` is in neither gate's
// include, so ~1,790 lines of card loaders (each with its own loading /
// failed / empty / data ladder) were unmeasured by construction.

import CollectionAnalyticsClient from "./CollectionAnalyticsClient";

export default function AnalyticsPage() {
  return <CollectionAnalyticsClient />;
}
