// app/(collections)/[collection]/collection/page.tsx
// Server shell. Behaviour lives in CollectionTabClient.tsx so the component
// coverage gate measures it — a `page.tsx` is in neither gate's include, so the
// wallet-moments state machine (saved wallets, badges, FMV batching, cost
// basis, pagination) was unmeasured by construction.

import CollectionTabClient from "./CollectionTabClient";

export default function CollectionPage() {
  return <CollectionTabClient />;
}
