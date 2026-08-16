// app/admin/listing-retry-queue/page.tsx
//
// Server shell. The whole surface lives in ListingRetryQueueClient so the COMPONENT
// coverage gate measures it — `app/**/page.tsx` matches neither gate's include, so
// every branch in this page was previously unmeasured however much logic it held.
// Behaviour is unchanged; this is a move.

import ListingRetryQueueClient from "./ListingRetryQueueClient";

export default function ListingRetryQueuePage() {
  return <ListingRetryQueueClient />;
}
