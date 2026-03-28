import { redirect } from "next/navigation"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function CollectionRoot(props: any) {
  const params = await props.params
  redirect(`/${params.collection}/overview`)
}