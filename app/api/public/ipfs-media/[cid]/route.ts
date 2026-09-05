// app/api/public/ipfs-media/[cid]/route.ts
//
// Gate-free IPFS media proxy. UFC Strike (and any legacy ipfs.io-served) edition
// art/video is stored as an extensionless public-gateway URL
// (https://ipfs.io/ipfs/<cid>). The public ipfs.io gateway is slow and flaky —
// a UFC hero is a ~4 MB full-res RGBA PNG, so the browser <img>/<video> often
// gives up before it paints, leaving an empty black box (QA sweep 2026-07-02).
//
// This route fetches the CID server-side (our egress reaches ipfs.io reliably)
// and streams it back same-origin with the correct content-type and a long,
// immutable edge cache. Anon-public via proxy.ts (/api/public).
//
// SIZE CEILING (2026-07-27) — the edge cache silently refuses large responses.
// This route's original header claimed "the first request warms the Vercel edge
// and every subsequent load is a fast, cached same-origin hit". That is true for
// images and FALSE for video, because the objects exceed Vercel's maximum
// cacheable response size. Measured against production, same URL three times:
//
//   4.03 MB image/png  -> MISS, HIT,  HIT   (cached, amortised)
//   16.75 MB video/mp4 -> MISS, MISS, MISS  (never cached)
//   23.27 MB video/mp4 -> MISS, MISS, MISS  (never cached)
//
// The delivered header also comes back with `s-maxage` STRIPPED on the oversize
// responses. So every single video view cost a full 16-23 MB of Fast Data
// Transfer, forever, with zero amortisation — 10,786 editions carry an IPFS
// video URL (Top Shot 10,270, UFC 516), and that is the Fast Data Transfer
// alert. Above MAX_PROXY_BYTES we now 302 to the upstream gateway instead, so
// Vercel transfers zero bytes for objects it could never have cached. The
// redirect is CSP-safe: proxy.ts already allows https://ipfs.io in BOTH
// `img-src` and `media-src`. It is also SSRF-safe — CID_RE has already validated
// the CID, so the redirect target is built from the same allowlisted token as
// the fetch.
//
// GET /api/public/ipfs-media/<cid>

import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

// CIDv0 (Qm… base58btc, 46 chars) or CIDv1 (b… base32, lowercase). The CID is
// echoed into the upstream path, so this allowlist regex is the SSRF guard —
// alnum only, no slashes/dots/query that could redirect the fetch elsewhere.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{40,})$/;
// ⭐ ORDERED BY MEASURED AVAILABILITY, primary first — see the note in GET().
// Both hosts are ALREADY in proxy.ts CSP `img-src` AND `media-src`, which is why
// this list is these two: the oversize path below 302s the browser straight at
// whichever gateway answered, so a gateway absent from the CSP would fix the
// proxy leg and break the redirect leg in the same change.
//
// ⛔ `cloudflare-ipfs.com` is in that CSP and is NOT in this list on purpose:
// the host is decommissioned and now fails DNS instantly (0/8 CIDs, <0.1 s).
//
// ⚠ EACH ENTRY IS AN SSRF-RELEVANT CONSTANT. CID_RE has already validated the
// CID, and these bases are literals — never build one from request input.
// 🚨 THIRD GATEWAY ADDED 2026-09-05 (overnight) — AND THE REASON IS THAT THE
// RANKING ABOVE WAS MEASURED ON A SAMPLE THAT CONTAINED NONE OF THE COLLECTION
// IT BROKE.
//
// The five-gateway table in GET() was measured against "8 CIDs taken live off
// `/nba-top-shot/market`" — i.e. entirely Top Shot, whose art IS pinned to
// Dapper's own Pinata account. On that sample `ipfs.dapperlabs.com` is 8/8 and
// fastest, so the list became [dapperlabs, ipfs.io] and that was right FOR TOP
// SHOT. ⭐ It is wrong for the one collection that is not on Dapper's gateway.
//
// **UFC Strike is the only collection served from ipfs.io — 518 thumbnails and
// 516 videos, and ZERO of its CIDs are Dapper-pinned.** Measured 2026-09-05
// against a live UFC CID (`QmWyFrRvjBEnCgbP2rNnyR2ktyLP5QnPBkwjCvh6XdtW9f`):
//
//     ipfs.dapperlabs.com   403 in 0.3-0.5 s — body: "The owner of this gateway
//                           does not have this content pinned to their Pinata
//                           account." A statement about the GATEWAY, not the CID.
//     ipfs.io               no response at all, 25 s, from two different networks
//     gateway.pinata.cloud  200 image/png 4.72 MB in 5.4 s
//
// So every UFC edition page served a broken image: the primary answered 403 fast,
// the secondary never answered, and the catch below passed the 403 through as if
// it were news about the content. A live QA sweep found it on 3 of 3 sampled UFC
// surfaces (`/ufc/edition/…`, `/ufc/set/…`, `/ufc/player/…`).
//
// ⚠ `gateway.pinata.cloud` was ALREADY in the measured table at 8/8, 3.5-7.0 s —
// it was passed over for being slower than Dapper, on a sample where Dapper could
// not lose. Losers are aborted the moment one gateway answers, so a slower third
// entry costs nothing on a CID the faster ones can serve.
//
// ⚠ EACH ENTRY IS AN SSRF-RELEVANT CONSTANT. CID_RE has already validated the
// CID, and these bases are literals — never build one from request input.
// ⚠ Adding a host here REQUIRES adding it to proxy.ts CSP `img-src` AND
// `media-src`, because the oversize path 302s the browser straight at it.
const GATEWAYS = [
  "https://ipfs.dapperlabs.com/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
] as const;

// Objects at or below this stream through us and cache at the edge; above it we
// redirect. 8 MB sits between the largest size proven to cache (4.03 MB) and the
// smallest proven not to (16.75 MB), leaving margin under Vercel's ceiling.
const MAX_PROXY_BYTES = 8 * 1024 * 1024;

// Time budget for the upstream to send us HEADERS. Deliberately well UNDER the
// platform's own 25s initial-response cutoff: this was 25_000, i.e. exactly the
// platform limit, so the platform always won the race and killed the function
// with `504 [error/serverless-middleware] … did not return an initial response
// within 25s` BEFORE the catch below could run. That made the 502 fallback —
// and the <img onError> candidate-advance chain it exists to trigger —
// unreachable dead code for precisely the slow-gateway case it was written for
// (205 such 504s in one 40-minute window on 2026-07-27). At 8s the abort fires
// first, so the soft-fail path actually works.
const HEADERS_TIMEOUT_MS = 8_000;

// 🚨 A SECOND, SEPARATE BUDGET FOR THE BODY — AND THE REASON IS A MEASURED
// DEFECT, NOT SYMMETRY (2026-09-03).
//
// `AbortSignal.timeout(8_000)` starts at fetch time and STAYS LIVE FOR THE
// RESPONSE BODY. This route returns `upstream.body` — a stream still governed by
// that signal — so a transfer that got its headers at 6s and was still sending
// bytes at 8s was ABORTED MID-FLIGHT, after a 200 and the success log had
// already gone out. Straight from production, one request:
//
//   06:43:52 GET …/Qmbeyu7oxhX… 200
//     [ipfs-media] ok cid=Qmbeyu7oxhX… type=image/png hasLength=true
//       bytes=3777843 elapsedMs=6037
//     TimeoutError: The operation was aborted due to timeout   (×4)
//
// ⭐ THE SUCCESS LOG AND THE FAILURE ARE THE SAME REQUEST. 426 such uncaught
// TimeoutErrors across 60 users in the 24 h to 2026-09-03 06:00Z, and every one
// of them is a load this route had already WON at the headers stage and then
// killed while delivering. The `catch` below cannot see any of it: the handler
// has already returned.
//
// ⚠ AND IT IS INVISIBLE AT THE ONE PLACE THAT LOOKS: the `ok` line is written
// BEFORE the stream is pumped, so the log says the transfer succeeded whatever
// happens next. That is this repo's own honesty class one layer down — the
// instrument reports the decision to stream, not the outcome of streaming.
//
// So the timeout is now TWO phases on ONE controller: `HEADERS_TIMEOUT_MS` to
// first byte (unchanged, and it is what keeps the 502 soft-fail reachable), then
// this budget for the transfer itself. Total ~20s, comfortably under the
// platform's 25s cutoff — which in any case no longer applies once headers are
// sent, so the real backstop for a hung stream is the function's own lifetime.
//
// ⛔ NOT "raise the one timeout to 20s". That would give a dead gateway 20s
// before the <img onError> chain can advance, which is the regression the 8s
// value was chosen to prevent. The two phases answer different questions.
const BODY_TIMEOUT_MS = 12_000;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ cid: string }> },
): Promise<NextResponse> {
  const { cid: raw } = await params;
  const cid = decodeURIComponent(raw ?? "").trim();
  if (!CID_RE.test(cid)) {
    return new NextResponse(null, { status: 400 });
  }

  const startedMs = Date.now();

  // ⚠ OBSERVABILITY, added 2026-08-24. This route returned its 502 SILENTLY, and
  // that made its dominant outcome unattributable: measured over 72 h of
  // cache-MISS invocations, **99 × 502 against 26 × 200 and 5 × 302** — i.e.
  // ~76% of uncached media loads fail — with nothing in the logs to say WHY.
  // "Our 8 s abort fired" and "ipfs.io answered 5xx" are different problems with
  // different fixes and they were spelled identically.
  //
  // ⭐ THAT 76% IS NOW EXPLAINED, AND IT WAS NEVER OUR TIMEOUT (2026-09-05).
  // Both readings above blamed the same thing — a slow gateway — and neither
  // asked whether a DIFFERENT gateway would answer. Measured against 8 CIDs
  // taken live off `/nba-top-shot/market`, HEAD, from a residential box:
  //
  //     ipfs.dapperlabs.com   8/8   0.2–1.9 s
  //     gateway.pinata.cloud  8/8   3.5–7.0 s
  //     ipfs.filebase.io      7/8   0.0–0.9 s
  //     ipfs.io               2/8   (six 12 s timeouts)
  //     cloudflare-ipfs.com   0/8   (DNS gone — the host is decommissioned)
  //
  // ⛔ SO THE ART IS FINE AND ALWAYS WAS. A prior entry concluded these were
  // COLD-CACHE MISSES that a retry would warm, on the strength of one CID
  // answering 200 on a third try. That does not generalise: re-probed 2026-09-05,
  // one CID returned **502 on four consecutive attempts, every one at 8.1 s with
  // `x-vercel-cache: MISS`**, while `ipfs.io` itself answered **504 after 28 s**.
  // Nothing was warming, because ipfs.io could not serve the object at all.
  //
  // ⚠ This route has ALREADY been bitten by exactly that blindness: its header
  // records that the 502 path was unreachable DEAD CODE for the slow-gateway
  // case it exists for, because the old 25 s timeout lost the race to the
  // platform's own 25 s cutoff. That went unnoticed until someone counted 504s
  // by hand. A soft-fail nobody can see is indistinguishable from one that works.
  //
  // ⓘ Measured against ipfs.io from a residential box 2026-08-24, so the
  // instrumentation has a baseline to be read against: three sampled CIDs
  // returned **HTTP 504 from the gateway itself after ~28 s** on a full-object
  // GET, and one was a 36 MB object with a 0.07 s TTFB that was still streaming
  // at 40 s. ⛔ A promising "ranged requests succeed where full GETs 504" reading
  // did NOT reproduce on re-test and is deliberately not recorded as a lever.
  // ⚠ A MANUAL CONTROLLER, NOT `AbortSignal.timeout` — that helper cannot be
  // rescheduled, and rescheduling is the whole fix (see BODY_TIMEOUT_MS). The
  // abort reason keeps `name: "TimeoutError"` so the branch below, and every
  // reader of these logs, still discriminates a timeout from a transport fault
  // exactly as before.
  const timeoutError = (ms: number, phase: "headers" | "body") => {
    const e = new Error(`ipfs-media ${phase} timeout after ${ms}ms`);
    e.name = "TimeoutError";
    return e;
  };

  // One controller PER GATEWAY. The headers deadline aborts them all; once a
  // winner is chosen only the winner's is re-armed for the transfer, and the
  // losers' are aborted immediately so no bytes are pulled for a race we lost.
  const controllers = GATEWAYS.map(() => new AbortController());
  let phaseTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    const e = timeoutError(HEADERS_TIMEOUT_MS, "headers");
    for (const c of controllers) c.abort(e);
  }, HEADERS_TIMEOUT_MS);

  /** A gateway that did not give us a streamable 2xx, and why. */
  type GatewayFailure = {
    base: string;
    /** The status it ANSWERED with, or null when it never answered at all. */
    status: number | null;
    reason: "abort_timeout" | "transport" | "not_ok";
    name: string;
  };

  const attempts = GATEWAYS.map(async (base, i) => {
    let res: Response;
    try {
      res = await fetch(`${base}${cid}`, {
        headers: { "User-Agent": "rip-packs-city/ipfs-media" },
        signal: controllers[i].signal,
      });
    } catch (err) {
      // ⚠ CLASSIFY OFF THE SIGNAL, NOT OFF THE ERROR'S NAME. Naming which of the
      // two failures happened is the whole point of this line — raising
      // HEADERS_TIMEOUT_MS only helps the abort kind — and `err.name` is not a
      // reliable way to ask. `AbortSignal.timeout` used to reject with a
      // DOMException named "TimeoutError", but a manual `controller.abort(reason)`
      // is only guaranteed to preserve that reason in SOME runtimes (verified in
      // Node; the edge runtime is a different implementation). `signal.aborted` is
      // this route's own state and cannot be reinterpreted by a runtime.
      //
      // ⓘ The distinction is live, not theoretical: an unresolvable CID probed on
      // 2026-09-03 failed at **7,800 ms** with `name=Error` — 200 ms INSIDE the
      // 8,000 ms deadline — while every real abort in the preceding logs sits at
      // 7,982–7,999 ms. That one is a genuine transport fault and must not be
      // relabelled as our timeout just because it happened to land nearby.
      const failure: GatewayFailure = {
        base,
        status: null,
        reason: controllers[i].signal.aborted ? "abort_timeout" : "transport",
        name: err instanceof Error ? err.name : "unknown",
      };
      throw failure;
    }
    if (!res.ok || !res.body) {
      // Distinct from the branch above: the gateway ANSWERED and said no. A 504
      // here is the gateway's own, not ours, and no timeout change can move it.
      res.body?.cancel().catch(() => {});
      const failure: GatewayFailure = { base, status: res.status, reason: "not_ok", name: "not_ok" };
      throw failure;
    }
    // `body` is returned NARROWED, not re-read downstream: the check above is
    // what proves it non-null, and carrying the proof is cheaper than an
    // unreachable re-check that would read as a real branch.
    return { base, res, body: res.body, index: i };
  });

  let winner: { base: string; res: Response; body: ReadableStream<Uint8Array>; index: number };
  try {
    // ⚠ RACED, NOT TRIED IN SEQUENCE, and the reason is the platform's 25 s
    // initial-response cutoff. Sequential fallback costs the SUM of the budgets:
    // two gateways at HEADERS_TIMEOUT_MS each is 16 s, and adding BODY_TIMEOUT_MS
    // puts the worst case past the cutoff — reviving precisely the dead-502 bug
    // this route's header documents. Raced, the headers phase still costs at most
    // HEADERS_TIMEOUT_MS no matter how many gateways are listed, so the fallback
    // is free in the dimension that was already tight.
    //
    // ⚠ `Promise.any` and not `Promise.race`: a gateway answering 504 must not
    // win the race and end the request. Each attempt REJECTS on a non-ok answer,
    // so only a streamable 2xx can settle this.
    winner = await Promise.any(attempts);
  } catch (agg) {
    clearTimeout(phaseTimer);
    // `AggregateError.errors` preserves the input order, so `failures[0]` is the
    // PRIMARY gateway's outcome.
    const failures: GatewayFailure[] = (agg as AggregateError)?.errors ?? [];
    // ⚠ A 401/403 IS NOT AN ANSWER ABOUT THE CONTENT — it is an answer about the
    // GATEWAY, and passing it through is what hid a retrievable object. Dapper's
    // gateway 403s every CID it has not pinned, with a body that says exactly
    // that, so a UFC CID would surface "403" to the caller even when another
    // gateway had the bytes. Prefer any other answered status; fall back to the
    // auth-shaped one only when it is the only answer there is.
    const answered =
      failures.find((f) => f.status !== null && f.status !== 401 && f.status !== 403) ??
      failures.find((f) => f.status !== null);
    const detail = failures
      .map((f) => `${new URL(f.base).host}=${f.reason}${f.status === null ? "" : `:${f.status}`}`)
      .join(" ");
    // ⚠ THE FIELD NAMES ARE DELIBERATELY THE OLD ONES. This used to be two log
    // lines — `reason=`/`name=` for a fetch that threw, `upstreamStatus=` for a
    // gateway that answered no — and with a fallback chain there is only one
    // outcome to report. Renaming the fields would have silently emptied every
    // existing operator query against this route rather than changing what they
    // returned, which is the worse of the two failure modes: a dashboard that
    // reads zero looks like a route that stopped failing.
    //
    // ⚠ `reason`/`name` describe the PRIMARY gateway specifically, `upstreamStatus`
    // the first gateway that answered at all, and `detail` carries every one of
    // them — so the single-gateway reading stays true and the fan-out is visible.
    //
    // ⚠ `upstreamStatus` is OMITTED ENTIRELY when no gateway answered, rather than
    // printed as `none`. An abort is not an upstream status, and a field that is
    // always present teaches a reader to treat its absence as impossible — the
    // route test pins this by asserting the token does not appear on an abort.
    console.log(
      `[ipfs-media] every gateway failed cid=${cid} gateways=${GATEWAYS.length} ` +
        `reason=${failures[0]?.reason ?? "unknown"} name=${failures[0]?.name ?? "unknown"} ` +
        `${answered === undefined ? "" : `upstreamStatus=${answered.status} `}detail=${detail} elapsedMs=${Date.now() - startedMs}`,
    );
    // ⚠ THE ANSWERED STATUS IS STILL PASSED THROUGH, in gateway order. When a
    // gateway actually replied — a 404 for a CID that does not exist, a 504 it
    // generated itself — that status is more informative than a blanket 502 and
    // this route has always surfaced it. Only when NO gateway answered at all
    // (every one aborted or faulted at the transport layer) is 502 the honest
    // summary: "we could not reach any of them" is not a status any of them gave.
    return new NextResponse(null, { status: answered?.status ?? 502 });
  }

  // Won. Stop the losers before they stream anything to us.
  for (let i = 0; i < controllers.length; i += 1) {
    if (i !== winner.index) controllers[i].abort(new Error("ipfs-media: another gateway answered first"));
  }

  const upstream = winner.res;
  const upstreamBody = winner.body;
  // ⚠ LOGGED ON EVERY OUTCOME, NOT JUST FAILURES. The whole point of this route
  // is WHICH gateway serves, and without naming it on the success path nobody can
  // answer "is the fallback earning its keep, or is the primary carrying it all?"
  // — and a silent primary outage would fall back, restore the old failure rate,
  // and leave the logs saying nothing about why. Fixing the behaviour without
  // fixing the record leaves the incidence unmeasurable.
  const gateway = new URL(winner.base).host;
  const upstreamUrl = `${winner.base}${cid}`;

  // Headers are in. Re-arm the WINNER's controller for the transfer, so the body
  // gets its own budget instead of inheriting the remainder of the headers one.
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(
    () => controllers[winner.index].abort(timeoutError(BODY_TIMEOUT_MS, "body")),
    BODY_TIMEOUT_MS,
  );

  // Oversize: hand the client straight to the gateway. Cancel our own body so
  // the bytes are never pulled through this function. A missing/unparseable
  // content-length (chunked upstream) falls through to the streaming path —
  // the old behaviour — rather than guessing.
  // ⚠ A COERCION TRAP WORTH NAMING, found 2026-08-24 while instrumenting this.
  // The comment above says a missing content-length "falls through to the
  // streaming path", and it DOES — but not by the mechanism it sounds like.
  // `headers.get()` returns `null` when absent, and `Number(null ?? "")` is
  // **0**, for which `Number.isFinite` is **TRUE**. So the missing case is not
  // detected as missing; it becomes a finite ZERO that simply fails the `>`
  // comparison. The outcome is correct today and the reasoning is not, which is
  // exactly the shape that breaks when someone later inverts the condition —
  // `if (!Number.isFinite(...))` would classify a chunked upstream as a parsed
  // length of nothing. `rawLength` below tests PRESENCE, so the two questions
  // stay separate.
  const rawLength = upstream.headers.get("content-length");
  const declaredLength = Number(rawLength ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_BYTES) {
    clearTimeout(phaseTimer);
    upstreamBody.cancel().catch(() => {});
    console.log(
      `[ipfs-media] oversize redirect cid=${cid} gateway=${gateway} bytes=${declaredLength} elapsedMs=${Date.now() - startedMs}`,
    );
    return NextResponse.redirect(upstreamUrl, 302);
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  // The SUCCESS leg is logged too, deliberately. Volume is trivial (26 in 72 h)
  // and it makes one log query answer "what happened to this route" instead of
  // requiring a status-code aggregate alongside a message search.
  //
  // ⚠ `hasLength=false` is the case worth watching: a chunked upstream has no
  // `content-length`, so the oversize check above cannot fire and a multi-MB
  // object streams through uncacheable — the exact Fast Data Transfer shape this
  // file's SIZE CEILING note was written for. It was previously indistinguishable
  // from a small cached image.
  console.log(
    `[ipfs-media] ok cid=${cid} gateway=${gateway} type=${contentType} hasLength=${rawLength != null} bytes=${rawLength ?? "unknown"} elapsedMs=${Date.now() - startedMs}`,
  );

  // ⚠ THE `ok` LINE ABOVE RECORDS A DECISION, NOT AN OUTCOME — it is written
  // before a single byte has been pumped, which is how 426 aborted transfers in
  // 24 h sat behind 200s that all logged success (see BODY_TIMEOUT_MS). So the
  // stream is counted, and a SECOND line is written when it actually finishes.
  //
  // ⭐ Read the two by CORRELATION, exactly like the pipeline heartbeat marker:
  //   `ok` + `streamed` -> the client got the whole object.
  //   `ok` with NO `streamed` -> the transfer started and died mid-flight.
  // `flush` does not run when a stream errors, and that ABSENCE is the signal —
  // deliberately, because a catch-and-log here cannot un-send the 200 that has
  // already gone out.
  //
  // It also clears the body timer, so a completed transfer leaves no pending
  // timeout behind to fire against an already-settled fetch.
  let delivered = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      delivered += chunk.byteLength;
      ctl.enqueue(chunk);
    },
    flush() {
      clearTimeout(phaseTimer);
      console.log(
        `[ipfs-media] streamed cid=${cid} bytes=${delivered} declared=${rawLength ?? "unknown"} elapsedMs=${Date.now() - startedMs}`,
      );
    },
  });

  return new NextResponse(upstreamBody.pipeThrough(counted), {
    headers: {
      "Content-Type": contentType,
      // CID is immutable — cache hard at the edge + browser.
      "Cache-Control": "public, max-age=86400, s-maxage=31536000, immutable",
    },
  });
}
