// app/(collections)/[collection]/badges/page.tsx
// Redirects the old /badges route to /market
import { redirect } from "next/navigation"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function BadgesRedirect(props: any) {
  const params = await props.params
  const collection = params?.collection || "nba-top-shot"
  redirect(`/${collection}/market`)
}
