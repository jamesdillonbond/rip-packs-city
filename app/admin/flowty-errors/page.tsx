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
import { loadErrorTriage } from "@/lib/admin/error-triage";
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

  // ⚠ The reads live in lib/ so they are BOUNDED and TESTABLE — see that
  // module's header. The `loadError` distinction is unchanged; what changed is
  // that reads which merely HANG can now reach it, with their own sentence
  // rather than a fabricated driver message.
  let dashboard: DashboardPayload | null = null;
  let summary: SummaryRow[] = [];
  let loadError: string | null = null;

  if (authed) {
    ({ dashboard, summary, error: loadError } = await loadErrorTriage<
      DashboardPayload,
      SummaryRow
    >());
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
