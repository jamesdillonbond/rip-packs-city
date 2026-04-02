// app/(collections)/[collection]/badges/page.tsx
// Redirects the old /badges route to /market
import { redirect } from "next/navigation"

export default function BadgesRedirect({
  params,
}: {
  params: { collection: string }
}) {
  redirect(`/${params.collection}/market`)
}
