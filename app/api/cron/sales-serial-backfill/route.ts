import { NextRequest, NextResponse, after } from "next/server";

// Thin Vercel-cron trigger for the `sales-serial-backfill` Supabase edge function
// (the on-chain / GQL serial-recovery sweep for sales that landed with a NULL
// serial). The edge fn resolves TopShot serials via topshot-proxy getMintedMoment
// and AllDay serials via on-chain AllDay.borrowMomentNFT — reads a Vercel route
// can't make itself — so this route just POSTs to it and returns.
//
// Why this exists: the edge fn had no durable trigger (its only footprint was
// ad-hoc runs), so honest-NULL serials — offer_fill TopShot moments not yet
// hydrated, and the AllDay tail — weren't draining. The DB-side pg_cron sweep
// `rpc-recover-null-serial-sales` handles anything already in moments/wmc; this
// covers the never-hydrated tail that needs an on-chain/GQL lookup.
//
// The edge fn is verify_jwt=false and accepts EITHER an Authorization header
// containing INGEST_SECRET_TOKEN or `?token=<INGEST_SECRET_TOKEN>`.
//
// 🚨 THE TOKEN IS SENT AS A HEADER, NEVER IN THE URL, AND THAT IS THE POINT.
// This route used to build `…/sales-serial-backfill?token=${ingest}`. **Supabase
// edge-function logs record full request URLs**, so `INGEST_SECRET_TOKEN` — a
// secret SHARED ACROSS ~15 edge functions — was written into the log store on
// every call, ~12×/day, for as long as this ran. A header is not logged.
// ⛔ Do NOT "confirm" the old leak by reading those logs: reading them IS the
// leak. The caller's source was the proof, and it is this line.
// ⚠ The token should still be treated as EXPOSED and rotated — this stops new
// writes, it does not un-write the old ones. That rotation is its own project
// (~15 functions), not a step here.
// ⓘ This is step (b) of the 3-step fix recorded in
// `docs/reference/known-issues.md` → Deferred hardening. Step (a) (tighten the
// edge fn's header branch from a SUBSTRING match to strict `Bearer` equality)
// and step (c) (delete its `?token=` branch) are edge deploys and are NOT done
// here. **The order matters in one direction only: (c) before (b) 401s this
// caller.** (b) is safe on its own because the deployed header branch is a
// substring test, which `Bearer <token>` satisfies.
//
// Vercel cron invokes THIS route with `Authorization: Bearer $CRON_SECRET`; a
// manual run may use INGEST instead.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE_NAME = "sales-serial-backfill-trigger";
const EDGE_BATCH_SIZE = 300;

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const authorized =
    (!!cronSecret && auth === `Bearer ${cronSecret}`) ||
    (!!ingest && auth === `Bearer ${ingest}`);
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base || !ingest) {
    return NextResponse.json({ error: "Missing SUPABASE_URL or INGEST token" }, { status: 500 });
  }
  const url = `${base}/functions/v1/sales-serial-backfill`;

  // Fire-and-forget: the edge fn returns 202 immediately and processes the queue
  // via EdgeRuntime.waitUntil(). We only need to kick it off.
  after(async () => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ingest}`,
        },
        body: JSON.stringify({ batch_size: EDGE_BATCH_SIZE }),
        signal: AbortSignal.timeout(30_000),
      });
      console.log(`[${PIPELINE_NAME}] edge fn responded ${res.status}`);
    } catch (e) {
      console.log(
        `[${PIPELINE_NAME}] trigger threw: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  });

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: PIPELINE_NAME },
    { status: 202 }
  );
}

export async function POST(request: NextRequest) {
  return run(request);
}

export async function GET(request: NextRequest) {
  return run(request);
}
