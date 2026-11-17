// app/(collections)/[collection]/profile/[username]/page.tsx
//
// Server shell. The profile lives in CollectionProfileClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.
//
// Reading `params` here also removes the client's `useParams()`, so both identifiers arrive
// as plain props and the client is renderable by a test without a router.

import CollectionProfileClient from "./CollectionProfileClient";

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ collection: string; username: string }>;
}) {
  const { collection, username } = await params;
  return <CollectionProfileClient collection={collection} username={username} />;
}
