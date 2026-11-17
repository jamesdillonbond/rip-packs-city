// Pipeline failure alerter — runs every 30 min via cron-job.org
//
// Logic:
//   1. Find pipelines whose last 3 runs (within last 60 min) all failed.
//   2. Suppress: skip if already alerted within last 4 hours.
//   3. Send email via Resend.
//   4. Update pipeline_alert_state.
//
// Auth: same Bearer pattern as spork-proxy (INGEST_SECRET_TOKEN).
// Returns JSON summary of what was checked and alerted.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INGEST_SECRET = Deno.env.get("INGEST_SECRET_TOKEN");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const ALERT_EMAIL_TO = Deno.env.get("ALERT_EMAIL_TO");
const ALERT_EMAIL_FROM = Deno.env.get("ALERT_EMAIL_FROM") ?? "alerts@resend.dev";

const FAILURE_THRESHOLD = 3;
const LOOKBACK_MINUTES = 60;
const SUPPRESSION_HOURS = 4;

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runSql(sql: string): Promise<unknown[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/execute_sql_select`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    throw new Error(`SQL select failed ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function getFailingPipelines(): Promise<
  Array<{
    pipeline: string;
    recent_failures: number;
    last_error: string | null;
    last_alerted_at: string | null;
  }>
> {
  const url = `${SUPABASE_URL}/rest/v1/pipeline_runs` +
    `?select=pipeline,started_at,ok,error` +
    `&started_at=gte.${new Date(Date.now() - LOOKBACK_MINUTES * 60_000).toISOString()}` +
    `&order=started_at.desc&limit=1000`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
  });
  if (!res.ok) {
    throw new Error(`pipeline_runs fetch failed ${res.status}: ${await res.text()}`);
  }
  const rows: Array<{ pipeline: string; started_at: string; ok: boolean; error: string | null }> =
    await res.json();

  // Group by pipeline, take last N runs each
  const byPipeline = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!byPipeline.has(row.pipeline)) byPipeline.set(row.pipeline, []);
    byPipeline.get(row.pipeline)!.push(row);
  }

  const failing: Array<{
    pipeline: string;
    recent_failures: number;
    last_error: string | null;
  }> = [];
  for (const [pipeline, runs] of byPipeline) {
    const lastN = runs.slice(0, FAILURE_THRESHOLD);
    if (lastN.length < FAILURE_THRESHOLD) continue;
    const allFailed = lastN.every((r) => !r.ok);
    if (allFailed) {
      failing.push({
        pipeline,
        recent_failures: lastN.length,
        last_error: lastN[0].error,
      });
    }
  }

  // Fetch suppression state
  if (failing.length === 0) return [];
  const stateUrl = `${SUPABASE_URL}/rest/v1/pipeline_alert_state` +
    `?pipeline=in.(${failing.map((f) => `"${f.pipeline}"`).join(",")})` +
    `&select=pipeline,last_alerted_at`;
  const stateRes = await fetch(stateUrl, {
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
    },
  });
  const stateRows: Array<{ pipeline: string; last_alerted_at: string }> = stateRes.ok
    ? await stateRes.json()
    : [];
  const stateMap = new Map(stateRows.map((s) => [s.pipeline, s.last_alerted_at]));

  return failing.map((f) => ({
    ...f,
    last_alerted_at: stateMap.get(f.pipeline) ?? null,
  }));
}

async function sendEmail(
  pipelines: Array<{ pipeline: string; recent_failures: number; last_error: string | null }>,
) {
  const subject = pipelines.length === 1
    ? `[RPC alert] ${pipelines[0].pipeline} failing`
    : `[RPC alert] ${pipelines.length} pipelines failing`;

  const lines = pipelines.map((p) =>
    `<p><strong>${p.pipeline}</strong> — ${p.recent_failures} consecutive failures<br>` +
    `Last error: <code>${p.last_error ?? "unknown"}</code></p>`
  );

  const html =
    `<h3>Pipeline failures detected</h3>` +
    lines.join("\n") +
    `<hr><p style="color:#666;font-size:12px">` +
    `Threshold: ${FAILURE_THRESHOLD} consecutive failures within ${LOOKBACK_MINUTES} min. ` +
    `Suppression: ${SUPPRESSION_HOURS}h. Sent by pipeline-failure-alerts edge function.</p>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: ALERT_EMAIL_FROM,
      to: [ALERT_EMAIL_TO],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend failed ${res.status}: ${await res.text()}`);
  }
}

async function recordAlerts(
  pipelines: Array<{ pipeline: string; recent_failures: number; last_error: string | null }>,
) {
  const now = new Date().toISOString();
  const rows = pipelines.map((p) => ({
    pipeline: p.pipeline,
    last_alerted_at: now,
    last_failure_count: p.recent_failures,
    last_error_message: p.last_error,
    updated_at: now,
  }));

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/pipeline_alert_state?on_conflict=pipeline`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(rows),
    },
  );

  if (!res.ok) {
    throw new Error(`alert state upsert failed ${res.status}: ${await res.text()}`);
  }
}

Deno.serve(async (req: Request) => {
  try {
    const auth = req.headers.get("Authorization") ?? "";
    if (!INGEST_SECRET || auth !== `Bearer ${INGEST_SECRET}`) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    if (!RESEND_API_KEY || !ALERT_EMAIL_TO) {
      return jsonResponse(500, {
        error: "configuration_missing",
        hint: "Set RESEND_API_KEY and ALERT_EMAIL_TO secrets via Supabase dashboard",
      });
    }

    const failing = await getFailingPipelines();
    const cutoff = Date.now() - SUPPRESSION_HOURS * 3600_000;
    const toAlert = failing.filter(
      (f) =>
        f.last_alerted_at === null ||
        new Date(f.last_alerted_at).getTime() < cutoff,
    );
    const suppressed = failing.filter(
      (f) =>
        f.last_alerted_at !== null &&
        new Date(f.last_alerted_at).getTime() >= cutoff,
    );

    if (toAlert.length > 0) {
      await sendEmail(toAlert);
      await recordAlerts(toAlert);
    }

    return jsonResponse(200, {
      ok: true,
      checked_at: new Date().toISOString(),
      pipelines_failing: failing.length,
      pipelines_alerted: toAlert.length,
      pipelines_suppressed: suppressed.length,
      alerted: toAlert.map((f) => f.pipeline),
      suppressed: suppressed.map((f) => f.pipeline),
    });
  } catch (err) {
    const e = err as Error;
    return jsonResponse(500, {
      error: "internal_error",
      message: e.message ?? String(err),
    });
  }
});
