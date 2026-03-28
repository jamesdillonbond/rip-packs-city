import { redirect } from "next/navigation"

export default function CollectionRoot({
  params,
}: {
  params: { collection: string }
}) {
  redirect(`/${params.collection}/overview`)
}