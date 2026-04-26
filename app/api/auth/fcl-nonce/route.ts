// app/api/auth/fcl-nonce/route.ts
//
// Mints a single-use, 5-minute-TTL nonce for FCL Account Proof flows. The
// SignInWithDapper button asks for one of these, hands it to fcl.authenticate
// via the accountProof.resolver, then sends the proof + nonce to fcl-verify
// for server-side verification.

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export async function GET() {
  const nonce = randomBytes(32).toString("hex");

  const { error } = await supabase
    .from("fcl_auth_nonces")
    .insert({ nonce });

  if (error) {
    console.error("[auth/fcl-nonce]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ nonce, appIdentifier: "Rip Packs City" });
}
