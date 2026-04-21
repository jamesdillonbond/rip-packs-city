// app/page.tsx
//
// Root gate. Per Phase 1 spec: signed-in users go to their profile,
// signed-out users go to sign-in. No public homepage — this is an
// auth-first platform now.

import { redirect } from "next/navigation"
import { getCurrentUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

export default async function RootGate() {
  const user = await getCurrentUser()
  if (user) redirect("/profile")
  redirect("/login")
}
