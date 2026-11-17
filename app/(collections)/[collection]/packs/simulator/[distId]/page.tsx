// app/(collections)/[collection]/packs/simulator/[distId]/page.tsx
//
// Server shell. The simulator lives in PackSimulatorClient so the COMPONENT coverage
// gate measures it — `app/**/page.tsx` matches neither gate's include, so the sampling
// maths and every failure branch here were unmeasured.
//
// Awaiting `params` here also removes the client's `use(params)`, so the client takes
// plain props and is renderable by a test without a promise fixture.

import PackSimulatorClient from "./PackSimulatorClient";

export default async function PackSimulatorPage({
  params,
}: {
  params: Promise<{ collection: string; distId: string }>;
}) {
  const { collection, distId } = await params;
  return <PackSimulatorClient collectionSlug={collection} distId={distId} />;
}
