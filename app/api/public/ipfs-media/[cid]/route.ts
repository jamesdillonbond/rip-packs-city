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
const UPSTREAM = "https://ipfs.io/ipfs/";

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

  const upstreamUrl = `${UPSTREAM}${cid}`;
  const startedMs = Date.now();

  // ⚠ OBSERVABILITY, added 2026-08-24. This route returned its 502 SILENTLY, and
  // that made its dominant outcome unattributable: measured over 72 h of
  // cache-MISS invocations, **99 × 502 against 26 × 200 and 5 × 302** — i.e.
  // ~76% of uncached media loads fail — with nothing in the logs to say WHY.
  // "Our 8 s abort fired" and "ipfs.io answered 5xx" are different problems with
  // different fixes and they were spelled identically.
  //
  // ⚠ This route has ALREADY been bitten by exactly that blindness: its header
  // records that the 502 path was unreachable DEAD CODE for the slow-gateway
  // case it exists for, because the old 25 s timeout lost the race to the
  // platform's own 25 s cutoff. That went unnoticed until someone counted 504s
  // by hand. A soft-fail nobody can see is indistinguishable from one that works.
  //
  // ⓘ Measured against ipfs.io from a residential box the same day, so the
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
  const controller = new AbortController();
  const abortAfter = (ms: number, phase: "headers" | "body") =>
    setTimeout(() => {
      const e = new Error(`ipfs-media ${phase} timeout after ${ms}ms`);
      e.name = "TimeoutError";
      controller.abort(e);
    }, ms);

  let phaseTimer: ReturnType<typeof setTimeout> = abortAfter(HEADERS_TIMEOUT_MS, "headers");
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { "User-Agent": "rip-packs-city/ipfs-media" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(phaseTimer);
    // Gateway timeout/fault — 502 so the <img> onError can advance to the next
    // candidate / placeholder.
    //
    // The abort reason carries `name: "TimeoutError"` (see `abortAfter`), and
    // anything else is a genuine transport fault. Naming which one is the whole
    // point — raising HEADERS_TIMEOUT_MS only helps the first kind.
    const name = err instanceof Error ? err.name : "unknown";
    console.log(
      `[ipfs-media] upstream fetch failed cid=${cid} reason=${name === "TimeoutError" ? "abort_timeout" : "transport"} name=${name} elapsedMs=${Date.now() - startedMs}`,
    );
    return new NextResponse(null, { status: 502 });
  }
  // Headers are in. Re-arm the SAME controller for the transfer, so the body
  // gets its own budget instead of inheriting the remainder of the headers one.
  clearTimeout(phaseTimer);
  phaseTimer = abortAfter(BODY_TIMEOUT_MS, "body");

  if (!upstream.ok || !upstream.body) {
    clearTimeout(phaseTimer);
    // Distinct from the branch above: the gateway ANSWERED and said no. A 504
    // here is ipfs.io's own, not ours, and no timeout change can move it.
    console.log(
      `[ipfs-media] upstream not ok cid=${cid} upstreamStatus=${upstream.status} hasBody=${!!upstream.body} elapsedMs=${Date.now() - startedMs}`,
    );
    return new NextResponse(null, { status: upstream.status || 502 });
  }

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
    upstream.body.cancel().catch(() => {});
    console.log(
      `[ipfs-media] oversize redirect cid=${cid} bytes=${declaredLength} elapsedMs=${Date.now() - startedMs}`,
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
    `[ipfs-media] ok cid=${cid} type=${contentType} hasLength=${rawLength != null} bytes=${rawLength ?? "unknown"} elapsedMs=${Date.now() - startedMs}`,
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

  return new NextResponse(upstream.body.pipeThrough(counted), {
    headers: {
      "Content-Type": contentType,
      // CID is immutable — cache hard at the edge + browser.
      "Cache-Control": "public, max-age=86400, s-maxage=31536000, immutable",
    },
  });
}
