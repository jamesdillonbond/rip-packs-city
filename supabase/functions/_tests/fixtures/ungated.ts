// POSITIVE CONTROL for auth_gate_test.ts — NOT a deployed function. It does the
// two kinds of work the gate test must see (a database write and an upstream
// fetch) without checking its caller. The harness must flag it; if it ever
// passes, the stubs have stopped recording and every green row means nothing.
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")

Deno.serve(async () => {
  await fetch("https://upstream.invalid/feed")
  await supabase.from("anything").insert({ x: 1 })
  return new Response("ok")
})
