// app/api/public/profile/[username]/route.ts
//
// Public profile endpoint — NO auth required. Returns a bundle of trophy
// moments + bio + privacy-stripped saved-wallet summaries for the given
// username, suitable for the shareable /profile/[username] page.
//
// Path sits under /api/public/* which the proxy doesn't gate.
//
// The query itself lives in lib/profile/public-profile.ts, shared with the SSR
// shell at app/profile/[username]/page.tsx. The page used to call THIS route
// over HTTP to guarantee both saw one payload shape; that guarantee now comes
// from the shared function instead, without the extra lambda invocation per
// request. Keep the response mapping below a thin translation of that result —
// do not re-add a second copy of the query here.
//
// Lookup pattern (documented in the shared module): username -> user_id via the
// denormalized `profile_bio.username` cache -> trophies / saved_wallets keyed
// on user_id. Never join trophies / saved_wallets to profile_bio.username
// directly — that column is a cache, the source of truth is auth.users.id.

import { NextRequest, NextResponse } from "next/server";
import { getPublicProfile } from "@/lib/profile/public-profile";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params;
  const result = await getPublicProfile(username, "api");

  if (!result.ok) {
    // Preserve the exact historical error bodies: 400 and 500 return
    // { error }, 404 additionally echoes { username }.
    const body: Record<string, unknown> = { error: result.error };
    if (result.username !== undefined) body.username = result.username;
    return NextResponse.json(body, { status: result.status });
  }

  return NextResponse.json(result.data);
}
