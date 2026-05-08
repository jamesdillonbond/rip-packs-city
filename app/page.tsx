import { redirect } from "next/navigation"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import HomePageMarketing from "@/components/HomePageMarketing"

export default async function HomePage() {
  const user = await getCurrentUser()
  if (user) redirect("/dashboard")
  return <HomePageMarketing />
}
