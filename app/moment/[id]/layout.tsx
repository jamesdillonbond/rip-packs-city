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
import { supabaseAdmin } from "@/lib/supabase"

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ id: string }>
}

// Next hands the [id] segment URL-encoded (a Pinnacle legacy key
// `STAR-OEV1-SWHM:Digital Display:1` arrives percent-escaped) and
// resolve_moment_id matches the decoded colon form. Same decode the page does.
function decodeMomentId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export default async function MomentLayout({ children, params }: LayoutProps) {
  const { id: rawId } = await params
  const id = decodeMomentId(rawId)

  let resolvable: boolean
  try {
    const { data, error } = await (supabaseAdmin as any).rpc("resolve_moment_id", { p_id: id })
    if (error) {
      // Fail OPEN on an infrastructure error. A transient RPC failure must not
      // 404 a real moment and invite Google to drop it from the index — let the
      // page render and surface its own (soft) not-found instead.
      console.warn(`[moment-layout] resolve rpc error id=${id}: ${error.message}`)
      resolvable = true
    } else {
      resolvable = Array.isArray(data) ? data.length > 0 : data != null
    }
  } catch (err) {
    console.warn(
      `[moment-layout] resolve threw id=${id}: ${err instanceof Error ? err.message : String(err)}`,
    )
    resolvable = true
  }

  if (!resolvable) notFound()

  return <>{children}</>
}
