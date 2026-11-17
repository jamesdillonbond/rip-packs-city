// app/(collections)/[collection]/sets/page.tsx
//
// Server shell. The set tracker lives in CollectionSetsClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.
//
// Reading `params` here removes the client's `useParams()`, so the slug arrives as a plain
// prop and the client is renderable by a test without a router.

import CollectionSetsClient from "./CollectionSetsClient";
import Link from "next/link";
import PaniniSetProgress from "@/components/collection/PaniniSetProgress";

export default async function SetsPage({
  params,
}: {
  params: Promise<{ collection: string }>;
}) {
  const { collection } = await params;
  // Panini (no chain, owners are usernames): its own tracker over
  // panini_set_progress — the shared client keys on a wallet address and on
  // `editions` set membership, neither of which Panini has (2026-09-27).
  // 2026-10-25: below the tracker, the product pages (one per Panini product — the series-page counterpart).
  if (collection === "panini-blockchain") return <><PaniniSetProgress /><PaniniProductsLink collection={collection} /></>;
  return <CollectionSetsClient collection={collection} />;
}

function PaniniProductsLink({ collection }: { collection: string }) {
  return (
    <Link href={`/${collection}/product`} className="rpc-mono" data-testid="panini-products-link" style={{ display: "inline-block", marginTop: 16, fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--rpc-red-text)", textDecoration: "none" }}>
      Browse every Panini product →
    </Link>
  );
}
