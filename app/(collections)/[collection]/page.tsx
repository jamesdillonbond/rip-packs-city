import { redirect } from "next/navigation"

export default async function CollectionRoot(props: {
  params: Promise<{ collection: string }>
}) {
  const params = await props.params
  redirect(`/${params.collection}/overview`)
}