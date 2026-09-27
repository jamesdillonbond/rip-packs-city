// app/(collections)/[collection]/collection/page.tsx
// Server shell. Behaviour lives in CollectionTabClient.tsx so the component
// coverage gate measures it — a `page.tsx` is in neither gate's include, so the
// wallet-moments state machine (saved wallets, badges, FMV batching, cost
// basis, pagination) was unmeasured by construction.

import CollectionTabClient from "./CollectionTabClient";
import PaniniCollection from "@/components/collection/PaniniCollection";

export default async function CollectionPage(props: { params: Promise<{ collection: string }> }) {
  const { collection } = await props.params;
  // Panini (2026-09-27): owners are USERNAMES and its cards are not in
  // wallet_moments_cache, which the shared tab reads — its own component reads
  // what RPC has seen under a username (panini_owner_cards).
  if (collection === "panini-blockchain") return <PaniniCollection />;
  return <CollectionTabClient />;
}
