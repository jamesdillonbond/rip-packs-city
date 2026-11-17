// lib/auth/supabase-server.ts
//
// Server-side Supabase auth helper. Reads/writes auth cookies via Next.js
// cookies() API so server components, route handlers, and server actions
// all share the same session.

import { createServerClient, type CookieOptions } from "@supabase/ssr"
import { cookies } from "next/headers"

export async function getSupabaseServer() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll().map((c) => ({ name: c.name, value: c.value }))
        },
        setAll(list: Array<{ name: string; value: string; options: CookieOptions }>) {
          list.forEach(({ name, value, options }) => {
            try {
              cookieStore.set({ name, value, ...options })
            } catch {
              // Server Components can't set cookies — middleware handles refresh.
            }
          })
        },
      },
    }
  )
}

// Returns the current user from any server context. Returns null if not signed in (never throws).
export async function getCurrentUser() {
  try {
    const supabase = await getSupabaseServer()
    const { data } = await supabase.auth.getUser()
    return data?.user ?? null
  } catch {
    return null
  }
}

// Throws a 401 Response if not signed in. Use inside route handlers:
//   const user = await requireUser()
export async function requireUser() {
  const user = await getCurrentUser()
  if (!user) {
    throw new Response(
      JSON.stringify({ error: "Authentication required" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    )
  }
  return user
}
