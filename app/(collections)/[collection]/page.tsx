import { redirect } from "next/navigation"

interface Props {
  params: Promise<{ collection: string }>
}

export default async function CollectionRoot({ params }: Props) {
  const { collection } = await params
  redirect(`/${collection}/overview`)
}