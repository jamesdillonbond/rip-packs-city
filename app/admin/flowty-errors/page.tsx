// app/admin/flowty-errors/page.tsx
// Trevor-only error-triage console. Server-component entry that gates on the
// rpc_admin_token cookie (or ?token= query param) against RPC_ADMIN_TOKEN.
// When authed it server-side fetches the dashboard rollup + the unfiltered
// status summary directly via supabaseAdmin and hydrates the client component
// for tab switching, drilldowns, and the triage form.
//
// proxy.ts allows /admin/* through unauthenticated, so the env-token check is
// the only gate. When the cookie is missing or wrong we render the client
// without initial data and let it show its sign-in screen.

import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase";
import ErrorTriageClient, {
  type DashboardPayload,
  type SummaryRow,
} from "./ErrorTriageClient";

export const dynamic = "force-dynamic";

interface SearchParams {
  token?: string | string[];
}

export default async function FlowtyErrorsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const expected = process.env.RPC_ADMIN_TOKEN ?? "";
  const sp = await searchParams;
  const queryToken =
    typeof sp.token === "string" ? sp.token : Array.isArray(sp.token) ? sp.token[0] : "";
  const cookieStore = await cookies();
  const cookieToken = cookieStore.get("rpc_admin_token")?.value ?? "";
  const presented = queryToken || cookieToken;
  const authed = !!expected && presented === expected;

  let dashboard: DashboardPayload | null = null;
  let summary: SummaryRow[] = [];
  let loadError: string | null = null;

  if (authed) {
    const [dashRes, sumRes] = await Promise.all([
      supabaseAdmin.rpc("get_error_triage_dashboard"),
      supabaseAdmin.rpc("get_error_triage_summary", { p_status_filter: null }),
    ]);
    if (dashRes.error) {
      console.log(`[flowty-errors] dashboard rpc error: ${dashRes.error.message}`);
      loadError = dashRes.error.message;
    } else {
      const d = dashRes.data;
      // The RPC may return a scalar JSON object or a single-row array.
      if (Array.isArray(d)) {
        dashboard = (d[0] ?? null) as DashboardPayload | null;
      } else if (d && typeof d === "object") {
        dashboard = d as DashboardPayload;
      }
    }
    if (sumRes.error) {
      console.log(`[flowty-errors] summary rpc error: ${sumRes.error.message}`);
      if (!loadError) loadError = sumRes.error.message;
    } else if (Array.isArray(sumRes.data)) {
      summary = sumRes.data as SummaryRow[];
    }
  }

  return (
    <ErrorTriageClient
      authed={authed}
      initialDashboard={dashboard}
      initialSummary={summary}
      loadError={loadError}
    />
  );
}
