# Handoff — Search Console structured-data fix + Trade Hub interim guard (2026-06-01)

Plain-text, iPhone-pasteable. No code fences. Two independent items. Companion: docs/operations/seo-gsc-checklist-2026-05-31.md, docs/handoff-2026-05-31-next-block.md (item E summarized the Trade Hub guard; this doc has the full code).

CONTEXT
Now that the sitemap is live (33K URLs) Google is crawling the entity pages and parsing their Product JSON-LD — two Search Console emails arrived flagging Merchant-listings (5) + Product-snippets (3) issues. This is expected and mostly non-critical; the pages still index. Item 1 fixes them. Item 2 is the Trade Hub fake-tx-id guard. Both are code (lib/seo.ts + lib/trade-escrow + a route/nav), Cowork can't push. Prod: deploy READY past 56a47ef. No docs/FREEZE.md. Claude Code's direct file read wins over this doc — verify lines before editing.

GUARDRAILS: direct to main, no branches/PRs; commit via PowerShell git; full-file writes (no CRLF string-patches); after each: npx tsc --noEmit clean, deploy READY, smoke green.

================================================================
ITEM 1 (P2, SEO) — Fix the edition/pack Product JSON-LD so Search Console clears
================================================================
File: lib/seo.ts — function editionJsonLd (verified at lines ~533-575) and packJsonLd (~662-693). Every GSC issue maps to a gap in editionJsonLd:

ROOT CAUSE (each maps 1:1):
- "Missing field image" (CRITICAL, Merchant) — product.image is set ONLY when thumbnail_url exists (line ~551 `if (thumb) product.image = thumb`). ~46% of TS editions have a null thumbnail -> Product with no image.
- "Either offers, review, or aggregateRating should be specified" (CRITICAL, Product snippets) — product.offers is set ONLY when fmv>0 (line ~554). The structural NO_DATA editions (~5K TS) emit a bare Product with no offers and no review/rating.
- "Missing field description" — the builder never sets product.description.
- "Invalid string length in field sku" — product.sku = slug (line ~552). TS integer slugs ("8:133") are fine, but AllDay/UFC descriptive slugs (e.g. PADDY-PIMBLETT-UFC-FIGHT-NIGHT-SEP-4-2021-KO-TKO-23970 = 53 chars) exceed Google's ~50-char sku limit.
- "Missing hasMerchantReturnPolicy / shippingDetails (in offers)" (NON-critical, Merchant listings) — RPC is an intelligence/index site, NOT a store. The Merchant-listings rich result does not apply; these are safe to leave OR satisfy with static digital-good values.

DECISION (framing): present editions as an informational Product snippet (price from FMV/ask), NOT a shoppable Merchant listing. So fix the two CRITICALS + description + sku (they gate the Product rich result), and treat the Merchant return-policy/shipping warnings as ignorable (optionally add static values to silence them).

EDITS to editionJsonLd (keep the @graph + breadcrumb structure; change how `product` is built):
1. ALWAYS set image. The OG card route always renders a branded 1200x630, so use it as the fallback:
   const ogImage = slug ? `${BASE_URL}/api/og/edition?collection=${collectionUrlSlug}&slug=${encodeURIComponent(slug)}` : null;
   product.image = thumb || ogImage || `${BASE_URL}/api/og/default`;
   (always a non-empty absolute URL -> clears the image CRITICAL for every edition.)
2. ALWAYS set description (reuse the meta wording):
   product.description = `${playerName}${setName ? " — " + setName : ""}${tier ? " (" + tier + ")" : ""} on ${label}. Live FMV, recent sales, price history, and the packs that contained this edition.`;
3. Fix sku length — only emit sku when it's a short stable id; drop it for long descriptive slugs:
   if (slug && slug.length <= 40) product.sku = slug;  (TS integer pairs keep their sku; AllDay/UFC long slugs simply omit the optional sku field — valid.)
4. Widen offers so NO_DATA editions still satisfy the Product-snippets critical. The edition detail page already fetches highOffer (low_ask) via fetchHighOffer — pass low_ask into editionJsonLd and use it as the price when FMV is absent:
   - Change the signature to editionJsonLd(detail, collectionUrlSlug, lowAsk?: number|null) and have the page pass highOffer?.low_ask.
   - const priceUsd = (fmv !== null && fmv > 0) ? fmv : (lowAsk && lowAsk > 0 ? lowAsk : null);
   - if (priceUsd !== null) { product.offers = { "@type":"Offer", price: Math.round(priceUsd*100)/100, priceCurrency:"USD", availability:"https://schema.org/InStock", url }; }
   Most editions now have an ask via edition_offers (54% and climbing) or FMV; the residual no-price tail keeps a bare Product (still indexes, just no rich snippet — acceptable, do NOT fake review/aggregateRating).
5. OPTIONAL (silences the two Merchant non-criticals; only if you want them gone — purely cosmetic for an index site): inside the offers object add
   hasMerchantReturnPolicy: { "@type":"MerchantReturnPolicy", returnPolicyCategory:"https://schema.org/MerchantReturnNotPermitted" },
   shippingDetails: { "@type":"OfferShippingDetails", shippingRate:{ "@type":"MonetaryAmount", value:0, currency:"USD" }, deliveryTime:{ "@type":"ShippingDeliveryTime", handlingTime:{ "@type":"QuantitativeValue", minValue:0, maxValue:0, unitCode:"DAY" } } }
   (digital good: no returns, no shipping. Skip if you'd rather just ignore the Merchant rich result.)

Apply the SAME image+description+sku treatment to packJsonLd (~662-693): it has the identical `if (opts.image) product.image` gap and no description; give it an OG fallback image (/api/og/pack or /api/og/default) + a description.

DO NOT add fake review/aggregateRating — RPC has no review data; the offers field satisfies the Product-snippets "either/or" critical.

REVERT: git revert. VERIFY: paste a no-thumbnail edition URL and a NO_DATA edition URL into Google's Rich Results Test (search.google.com/test/rich-results) — both should show a valid Product with image+offers and 0 critical issues. Then in Search Console, open each report and click "Validate Fix". tsc clean, deploy READY.

OPERATOR (Trevor, in GSC, no code): these are mostly non-critical and the site still ranks — not an emergency. After the fix deploys, hit "Validate Fix" on both reports. If you never want the Merchant-listings rich result (you're an index, not a shop), it's fine to leave its non-critical warnings or unsubscribe from that report type; the Product-snippets criticals are the ones worth clearing.

================================================================
ITEM 2 (P2, trust/safety) — Trade Hub: stop returning fake on-chain tx ids
================================================================
File: lib/trade-escrow/fcl-submit.ts (full replacement below) + hide /dashboard/trade-hub. Detail in handoff-2026-05-31-next-block.md item E. WHY: all 5 submitters return fake 0xstub_ tx ids; live /api/trade-chain/* routes import them. Latent (propose 409s without match cols; UI unlinked) but it implies an on-chain swap that didn't happen. Trade escrow is live on-chain swapping — same class as Cart (shelved 2026-05-24). Shelve it: guard the submitters so they hard-fail loudly instead of faking success, until RPCTradeEscrow is deployed.

FULL REPLACEMENT for lib/trade-escrow/fcl-submit.ts (the 5 submit* throw unless RPC_TRADE_ESCROW_ADDRESS is set; the import block + types are unchanged from the current file — keep them):

Add this guard helper near the top (after contractAddress()):

function ensureLive(verb: string): void {
  const addr = process.env.RPC_TRADE_ESCROW_ADDRESS;
  if (!addr || addr === "<unset>") {
    throw new Error(`Trade escrow unavailable: RPCTradeEscrow contract not deployed (${verb}). Set RPC_TRADE_ESCROW_ADDRESS to enable.`);
  }
}

Then make EACH of submitProposeTrade / submitDepositToTrade / submitExecuteSwap / submitCancelTrade / submitReclaimExpired call ensureLive("<verb>") as their FIRST line (before logCall / before returning the stub). With the contract undeployed this throws, so the routes' try/catch returns a clean 500 "Trade escrow unavailable" instead of a fake tx id + a written trade_chain_state row. When the contract is deployed, set the env var and replace each stub body with the real fcl.send per the file's existing NEXT_STEPS notes.

ROUTE-LEVEL (cleaner UX than a 500): in app/api/trade-chain/{propose,execute,deposit-callback}/route.ts and app/api/admin/reclaim-expired-trades/route.ts, add at the top of each handler:
  if (!process.env.RPC_TRADE_ESCROW_ADDRESS) return NextResponse.json({ error: "Trade Hub is not available yet." }, { status: 503 });

NAV/UI: hide or 404 /dashboard/trade-hub while disabled. Simplest: in app/dashboard/trade-hub/page.tsx return notFound() (import from next/navigation) when !process.env.RPC_TRADE_ESCROW_ADDRESS, and remove any dashboard link to it. (TradeChainPanel.tsx already shows "Cancel signing not wired yet" — the page guard makes the whole panel unreachable.)

TRACKING: add Trade Hub to CLAUDE.md known-issues (recommended by the weekly report 3 weeks running). Cowork did NOT edit CLAUDE.md (it was mid-edit by the nightly pass) — left to you.

REVERT: git revert. VERIFY: POST /api/trade-chain/propose returns 503 (not a 0xstub_ id); /dashboard/trade-hub 404s; tsc clean, deploy READY.

END STATE: edition/pack pages emit valid Product structured data (image + description + offers always present, sku length-safe) so Search Console clears its criticals; and Trade Hub can no longer show a user a fabricated trade. Ship Item 1 first (it's live SEO hygiene on the now-crawled pages); Item 2 whenever — it's latent.
