// app/moment/[id]/layout.tsx
//
// Existence gate for /moment/<id>, and the ONLY place it can live.
//
// Why a layout (2026-07-25, soft-404 fix): this segment ships a `loading.tsx`,
// which makes Next wrap the PAGE in an implicit <Suspense>. Next then flushes the
// document shell plus that fallback immediately and streams the page afterwards —
// so by the time the page's own `notFound()` fires, the HTTP status line has
// already gone out as 200. The 404 arrived as a streamed error row
// (`NEXT_HTTP_ERROR_FALLBACK;404`) and the response was a textbook soft-404:
// HTTP 200 with "Moment Not Found" in the body. Reported live on
// /moment/GEN-DPIN-SIMB-S0.
//
// Verified empirically against Next 16.2.9 (this repo's version) with a
// four-variant probe, unresolvable id in each:
//   loading.tsx + notFound() in the page ............ 200  (the bug)
//   loading.tsx + notFound() in generateMetadata .... 200  (metadata streams too)
//   loading.tsx + notFound() in a segment layout .... 404  <- this file
//   no loading.tsx + notFound() in the page ......... 404  (loses the skeleton)
//
// A layout is part of the shell, so Next must await it BEFORE the first flush.
// That commits the real 404 while keeping loading.tsx's navigation skeleton — the
// no-loading.tsx variant works too but trades the skeleton away.
//
// The gate is deliberately `resolve_moment_id`, not `get_moment_detail`:
//   - it is the same resolver get_moment_detail calls internally, so a 404 here
//     is a STRICT SUBSET of what the page would have notFound()'d on — this can
//     never invent a false 404 for a page that used to render;
//   - it returns 0 rows / 1 row instead of a large jsonb payload, so the extra
//     round trip is cheap (the page's own get_moment_detail is now cache()'d, so
//     the request went from 2 heavy calls to 1 cheap + 1 heavy).
// The page keeps its own notFound() as a backstop for the residual case where the
// id resolves but no edition hydrates.

import { notFound } from "next/navigation"
import { decodeMomentId } from "@/lib/moment-detail-format"
import { resolveMomentId } from "@/lib/moment/resolve-moment-id"

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

// Next hands the [id] segment URL-encoded (a Pinnacle legacy key
// `STAR-OEV1-SWHM:Digital Display:1` arrives percent-escaped) and
// resolve_moment_id matches the decoded colon form. This used to be a private
// byte-identical copy of @/lib/moment-detail-format's decodeMomentId, which the
// page already imports — "same decode the page does" was true by duplication
// rather than by construction. Now it is the same function.

export default async function MomentLayout({ children, params }: LayoutProps) {
  const { id: rawId } = await params
  const id = decodeMomentId(rawId)

  // Fail OPEN on an infrastructure error. A transient RPC failure must not 404 a
  // real moment and invite Google to drop it from the index — let the page
  // render and surface its own (soft) not-found instead. That policy now lives
  // in the fetcher, where a test can drive both failure shapes; this keeps the
  // log line, which is the only part that is the layout's business.
  const { resolves, degraded, reason } = await resolveMomentId(id)
  if (degraded) console.warn(`[moment-layout] resolve unavailable id=${id}: ${reason}`)

  if (!resolves) notFound()

  return <>{children}</>
}
