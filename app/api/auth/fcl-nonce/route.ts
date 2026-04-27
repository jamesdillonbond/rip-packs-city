// app/api/auth/fcl-nonce/route.ts
//
// Mints a single-use, 5-minute-TTL nonce for FCL Account Proof flows. The
// SignInWithDapper button asks for one of these, hands it to fcl.authenticate
// via the accountProof.resolver, then sends the proof + nonce to fcl-verify
// for server-side verification.
//
// Hardening:
//  - 8s timeout guard so an upstream stall returns 503 instead of letting the
//    function 504 at the platform layer.
//  - HTML body detection (e.g. an upstream Cloudflare or Supabase error page
//    returned with a 200 or 5xx) is converted to a structured 503. We never
//    echo the HTML back to the caller — only the first 200 chars hit the log.

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const UPSTREAM_TIMEOUT_MS = 8000;

function looksLikeHtml(body: unknown): body is string {
  if (typeof body !== "string") return false;
  const trimmed = body.trimStart().slice(0, 64).toLowerCase();
  return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html");
}

export async function GET() {
  const startedAt = Date.now();
  const nonce = randomBytes(32).toString("hex");

  try {
    const insertPromise = supabase.from("fcl_auth_nonces").insert({ nonce });

    const { error, data } = (await Promise.race([
      insertPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("upstream_timeout: fcl-nonce insert exceeded " + UPSTREAM_TIMEOUT_MS + "ms")),
          UPSTREAM_TIMEOUT_MS
        )
      ),
    ])) as Awaited<typeof insertPromise>;

    // Some Supabase REST failures arrive as { error: { message: "<!DOCTYPE ..." } }
    // when a fronting CDN returns an HTML error page. Treat those the same way
    // we treat a raw HTML response — return 503 and log a snippet only.
    if (error) {
      const msg = error.message ?? String(error);
      if (looksLikeHtml(msg)) {
        console.error("[auth/fcl-nonce] upstream returned HTML body — snippet=" + msg.slice(0, 200));
        return NextResponse.json(
          { error: "auth_provider_unavailable", retry: true },
          { status: 503 }
        );
      }
      console.error("[auth/fcl-nonce] insert error: " + msg + " elapsed_ms=" + (Date.now() - startedAt));
      return NextResponse.json({ error: msg }, { status: 500 });
    }

    if (looksLikeHtml(data as unknown)) {
      console.error("[auth/fcl-nonce] upstream returned HTML data payload — snippet=" + String(data).slice(0, 200));
      return NextResponse.json(
        { error: "auth_provider_unavailable", retry: true },
        { status: 503 }
      );
    }

    return NextResponse.json({ nonce, appIdentifier: "Rip Packs City" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (looksLikeHtml(msg)) {
      console.error("[auth/fcl-nonce] upstream HTML thrown — snippet=" + msg.slice(0, 200));
    } else {
      console.error("[auth/fcl-nonce] exception=" + msg + " elapsed_ms=" + (Date.now() - startedAt));
    }
    return NextResponse.json(
      { error: "auth_provider_unavailable", retry: true },
      { status: 503 }
    );
  }
}
