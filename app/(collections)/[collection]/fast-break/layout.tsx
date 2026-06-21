import { redirect } from "next/navigation"

// Hidden for launch - Fast Break feature parked. Delete this file (or revert) to re-enable the route.
export default async function HiddenRouteLayout(props: {
  children: React.ReactNode
  params: Promise<{ collection: string }>
}) {
  const { collection } = await props.params
  redirect(`/${collection}/overview`)
}
