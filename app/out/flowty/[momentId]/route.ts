// Flowty interstitial — Flowty wound down its NFT marketplace May 2026; this page is the "closed" notice that routes users to the native marketplace. (copy updated 2026-06-22)
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { FLOWTY_MARKETPLACE_ENABLED, FLOWTY_INCIDENT_URL } from "@/lib/flowty-flags";

function logClick(args: {
  momentId: string;
  source: string;
  priceAtClick: string | null;
  destination: string;
  buyUrl: string;
}): void {
  const { momentId, source, priceAtClick, destination, buyUrl } = args;
  // Console diagnostic — kept for log-search continuity with the prior handler.
  console.log("[FLOWTY_CLICK]", {
    timestamp: new Date().toISOString(),
    momentId,
    source,
    priceAtClick,
    destination,
  });

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    // Fire-and-forget — never block the response on telemetry.
    supabase
      .from("outbound_clicks")
      .insert({
        surface: source,
        destination,
        moment_id: momentId,
        ask_price_usd: priceAtClick ? Number(priceAtClick) || null : null,
        buy_url: buyUrl,
      })
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) console.log("[FLOWTY_CLICK] supabase insert failed: " + error.message);
      });
  } catch (e) {
    console.log("[FLOWTY_CLICK] supabase init failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderBlockedPage(args: { momentId: string }): string {
  const safeMoment = escapeHtml(args.momentId);
  const safeIncident = escapeHtml(FLOWTY_INCIDENT_URL);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Flowty marketplace closed</title>
<style>
  html, body { margin: 0; padding: 0; background: #0a0a0a; color: #ffffff; font-family: var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
  .card { max-width: 560px; width: 100%; background: #111111; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 28px 28px 24px; box-shadow: 0 8px 32px rgba(0,0,0,0.45); }
  h1 { font-size: 18px; line-height: 1.3; margin: 0 0 14px; letter-spacing: 0.02em; text-transform: uppercase; color: #ffffff; }
  p { font-size: 14px; line-height: 1.55; margin: 0 0 14px; color: rgba(255,255,255,0.78); }
  .meta { font-size: 11px; color: rgba(255,255,255,0.45); margin: 0 0 18px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; }
  a.btn { display: inline-block; text-decoration: none; padding: 10px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
  a.primary { background: #E03A2F; color: #ffffff; }
  a.primary:hover { background: #c8322a; }
  a.secondary { background: transparent; color: rgba(255,255,255,0.8); border: 1px solid rgba(255,255,255,0.2); }
  a.secondary:hover { border-color: rgba(255,255,255,0.4); color: #ffffff; }
  a.link { color: #6aa3ff; }
</style>
</head>
<body>
  <main class="card">
    <h1>Flowty marketplace closed</h1>
    <p>Flowty wound down its NFT marketplace in May 2026, so buy actions through Flowty are no longer available. Your listing data is kept here for reference — browse and buy on the native marketplace (Top Shot, All Day, etc.) instead.</p>
    <p class="meta">Moment ID: ${safeMoment}</p>
    <p><a class="link" href="${safeIncident}" target="_blank" rel="noopener noreferrer">Read Flowty&rsquo;s announcement &rarr;</a></p>
    <div class="row">
      <a class="btn primary" href="/nba-top-shot/sniper">Back to Sniper</a>
      <a class="btn secondary" href="/nba-top-shot/collection">View your collection</a>
    </div>
  </main>
</body>
</html>`;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ momentId: string }> }
) {
  const { momentId } = await context.params;
  const url = new URL(request.url);
  const source = url.searchParams.get("source") || "wallet-page";
  const priceAtClick = url.searchParams.get("priceAtClick") || null;

  const target =
    url.searchParams.get("target") ||
    `https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/NFT/${momentId}`;

  if (!FLOWTY_MARKETPLACE_ENABLED) {
    logClick({
      momentId,
      source,
      priceAtClick,
      destination: "flowty_listing_blocked",
      buyUrl: target,
    });
    const html = renderBlockedPage({ momentId });
    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  logClick({
    momentId,
    source,
    priceAtClick,
    destination: "flowty_listing",
    buyUrl: target,
  });
  return NextResponse.redirect(target, 302);
}
