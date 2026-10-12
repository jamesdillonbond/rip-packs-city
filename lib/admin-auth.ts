// lib/admin-auth.ts
// Bearer-token check for the Trevor-only /admin/* API routes.
// Deny-by-default: a missing or empty RPC_ADMIN_TOKEN env var means every
// request is rejected, so a misconfigured deployment fails closed.
//
// Accepts the token either as `Authorization: Bearer <token>` (the canonical
// path used by the admin UI via lib/admin-token.ts) or as a `?token=<token>`
// query string (the path cron-job.org GET probes use, since cron-job.org
// can't easily set arbitrary headers).

import { NextRequest, NextResponse } from "next/server";
import { bearerMatches, tokenMatches } from "@/lib/auth/bearer-secret";

export function verifyAdminRequest(req: NextRequest): boolean {
  // Constant-time, fail-closed (lib/auth/bearer-secret.ts; review S4 2026-10-11).
  // The ?token= form stays ONLY because cron-job.org probes are configured with
  // it; retiring it is a cron-job.org console change, not a code change.
  if (bearerMatches(req.headers.get("authorization"), "RPC_ADMIN_TOKEN")) return true;
  return tokenMatches(req.nextUrl.searchParams.get("token"), "RPC_ADMIN_TOKEN");
}

export function adminUnauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
