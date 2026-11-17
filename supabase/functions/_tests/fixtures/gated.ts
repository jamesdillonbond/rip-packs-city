// NEGATIVE CONTROL for auth_gate_test.ts — NOT a deployed function. The shape
// every real function should have: refuse first, work second.
import { createClient } from "@supabase/supabase-js"

const GATE = Deno.env.get("FIXTURE_GATE_KEY") ?? ""
const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

Deno.serve(async (req) => {
  const key = new URL(req.url).searchParams.get("key") ?? ""
  if (!GATE || key !== GATE) return new Response("forbidden", { status: 403 })
  await supabase.from("anything").insert({ x: 1 })
  return new Response("ok")
})
