// Sports data proxy — bypasses Vercel/Supabase egress blocks against
// stats.nba.com and api.draftkings.com, and reserves a slot for
// the-odds-api.com (wired when the Odds API key arrives).
//
// Routes (all POST, all gated by X-Proxy-Secret matching env.PROXY_SECRET):
//   POST /nba/scoreboard               → stats.nba.com/stats/scoreboardV2 (pass-through)
//   POST /nba/draftkings-projections   → DraftKings draftgroups + draftables (normalized)
//   POST /nba/odds                     → 501 placeholder until the Odds API key
//
// Cache:
//   /nba/scoreboard            → 5 min  (stats.nba.com is the truth source for live scoring)
//   /nba/draftkings-projections → 10 min (DK refreshes salary / status throughout the day)
//   /nba/odds                  → none (501)
//
// Same secret-rotation surface as topshot-proxy: PROXY_SECRET set via
// `wrangler secret put PROXY_SECRET` on this worker. Reuse the same value
// already stored in topshot-proxy's PROXY_SECRET so RPC env stays single-secret
// (each worker can be rotated independently later if needed).

interface Env {
  PROXY_SECRET: string;
}

const NBA_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const NBA_HEADERS: Record<string, string> = {
  "User-Agent": NBA_USER_AGENT,
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://www.nba.com",
  "Referer": "https://www.nba.com/",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
};

const DK_HEADERS: Record<string, string> = {
  "User-Agent": NBA_USER_AGENT,
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://www.draftkings.com",
  "Referer": "https://www.draftkings.com/",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Secret",
  "Access-Control-Max-Age": "86400",
};

function jsonResponse(body: unknown, status: number, cacheSeconds = 0): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (cacheSeconds > 0) headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  return new Response(JSON.stringify(body), { status, headers });
}

function passthroughResponse(upstreamBody: string, status: number, cacheSeconds = 0): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (cacheSeconds > 0) headers["Cache-Control"] = `public, max-age=${cacheSeconds}`;
  return new Response(upstreamBody, { status, headers });
}

// ─── /nba/scoreboard ──────────────────────────────────────────────────────────

interface ScoreboardBody {
  gameDate?: string;
}

async function handleScoreboard(request: Request): Promise<Response> {
  let body: ScoreboardBody;
  try {
    body = (await request.json()) as ScoreboardBody;
  } catch {
    return jsonResponse({ error: "invalid_json_body" }, 400);
  }
  const gameDate = (body.gameDate ?? "").trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(gameDate)) {
    return jsonResponse({ error: "gameDate_required_mmddyyyy" }, 400);
  }

  const url = new URL("https://stats.nba.com/stats/scoreboardV2");
  url.searchParams.set("DayOffset", "0");
  url.searchParams.set("LeagueID", "00");
  url.searchParams.set("GameDate", gameDate);

  const upstream = await fetch(url.toString(), {
    method: "GET",
    headers: NBA_HEADERS,
  });
  const text = await upstream.text();

  if (!upstream.ok) {
    return jsonResponse(
      {
        error: "upstream_failed",
        status: upstream.status,
        body_excerpt: text.slice(0, 800),
      },
      502,
    );
  }

  return passthroughResponse(text, 200, 300);
}

// ─── /nba/draftkings-projections ──────────────────────────────────────────────

interface DkContest {
  dg?: number;
  n?: string;
  sd?: string; // Microsoft JSON date: /Date(epoch_ms)/
  gameTypeId?: number;
}

interface DkLobbyResponse {
  Contests?: DkContest[];
}

interface DkDraftable {
  playerId?: number;
  playerDkId?: number;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  position?: string;
  rosterSlotId?: number;
  salary?: number;
  status?: string;
  team?: string;
  teamAbbreviation?: string;
  competition?: { competitionId?: number; name?: string; startTime?: string };
  draftStatAttributes?: { id?: number; name?: string; value?: string; sortValue?: string }[];
}

interface NormalizedPlayer {
  name: string;
  teamAbbr: string | null;
  position: string | null;
  salary: number | null;
  status: string | null;
  projFp: number | null;
  opponentAbbr: string | null;
  gameStartTime: string | null;
}

interface NormalizedDkResponse {
  draftGroupId: number | null;
  gameDate: string;
  players: NormalizedPlayer[];
  note?: string;
}

function todayInET(): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateInETFromMs(ms: number): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseMsJsonDate(sd: string | undefined): number | null {
  if (!sd) return null;
  const m = sd.match(/\/Date\((\d+)\)\//);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function pickDraftGroupId(contests: DkContest[], todayET: string): number | null {
  // Group Classic NBA contests by dg. Each dg is referenced by many contests
  // (varying entry fees / prize pools) but they share sd + gameTypeId.
  const classics = contests.filter(c => c.gameTypeId === 70 && typeof c.dg === "number");
  if (classics.length === 0) return null;

  type DgInfo = { dg: number; sd: number | null; count: number };
  const map = new Map<number, DgInfo>();
  for (const c of classics) {
    const dg = c.dg as number;
    const sd = parseMsJsonDate(c.sd);
    const existing = map.get(dg);
    if (!existing) {
      map.set(dg, { dg, sd, count: 1 });
    } else {
      existing.count += 1;
      if (sd != null && (existing.sd == null || sd > existing.sd)) existing.sd = sd;
    }
  }

  const dated = [...map.values()].filter(d => d.sd != null && dateInETFromMs(d.sd) >= todayET);
  if (dated.length > 0) {
    dated.sort((a, b) => {
      const sdDiff = (b.sd ?? 0) - (a.sd ?? 0);
      if (sdDiff !== 0) return sdDiff;
      return b.count - a.count;
    });
    return dated[0].dg;
  }

  // Fallback: no Classic NBA today, pick most-frequent regardless of date.
  const all = [...map.values()].sort((a, b) => b.count - a.count);
  return all[0]?.dg ?? null;
}

function extractProjFp(d: DkDraftable): number | null {
  const attrs = d.draftStatAttributes ?? [];
  // DK convention for NBA: draftStatAttributes id=219 carries projected
  // fantasy points. id=90 is the historic field used by some other sports
  // — kept as a fallback.
  for (const a of attrs) {
    if (a.id === 219) {
      const v = parseFloat(String(a.value ?? ""));
      if (Number.isFinite(v)) return v;
    }
  }
  for (const a of attrs) {
    if (a.id === 90) {
      const v = parseFloat(String(a.value ?? ""));
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

function mapStatus(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  const u = v.toUpperCase();
  if (u === "NONE") return "ACTIVE";
  if (u === "Q" || u === "GTD") return "QUESTIONABLE";
  if (u === "O" || u === "OUT") return "OUT";
  if (u === "IR") return "INACTIVE";
  return v;
}

function extractOpponent(compName: string | undefined, teamAbbr: string | null): string | null {
  if (!compName || !teamAbbr) return null;
  // DK competition.name comes through as "PHI @ NYK" or "PHI vs NYK".
  const m = compName.match(/([A-Z]{2,4})\s+(?:@|vs)\s+([A-Z]{2,4})/i);
  if (!m) return null;
  const ta = teamAbbr.toUpperCase();
  if (m[1].toUpperCase() === ta) return m[2].toUpperCase();
  if (m[2].toUpperCase() === ta) return m[1].toUpperCase();
  return null;
}

function normalizeDraftables(draftables: DkDraftable[]): NormalizedPlayer[] {
  // The draftables endpoint emits one row per (player, eligible roster slot)
  // — each player appears 2-4 times (PG, PG/SG, G, UTIL, etc). Dedupe by
  // displayName, keeping the entry with the smallest rosterSlotId for a
  // deterministic pick.
  const dedup = new Map<string, DkDraftable>();
  for (const d of draftables) {
    const key = (d.displayName ?? `${d.firstName ?? ""} ${d.lastName ?? ""}`).trim();
    if (!key) continue;
    const existing = dedup.get(key);
    if (!existing) {
      dedup.set(key, d);
      continue;
    }
    const a = typeof d.rosterSlotId === "number" ? d.rosterSlotId : Number.POSITIVE_INFINITY;
    const b = typeof existing.rosterSlotId === "number" ? existing.rosterSlotId : Number.POSITIVE_INFINITY;
    if (a < b) dedup.set(key, d);
  }

  const out: NormalizedPlayer[] = [];
  for (const d of dedup.values()) {
    const name = (d.displayName ?? `${d.firstName ?? ""} ${d.lastName ?? ""}`).trim();
    if (!name) continue;
    const teamAbbr = (d.teamAbbreviation ?? d.team ?? null)?.trim() || null;
    out.push({
      name,
      teamAbbr,
      position: (d.position ?? null)?.trim() || null,
      salary: typeof d.salary === "number" ? d.salary : null,
      status: mapStatus(d.status),
      projFp: extractProjFp(d),
      opponentAbbr: extractOpponent(d.competition?.name, teamAbbr),
      gameStartTime: d.competition?.startTime ?? null,
    });
  }
  return out;
}

async function handleDraftKingsProjections(_request: Request): Promise<Response> {
  const todayET = todayInET();

  // Step A: discover today's NBA Classic draft group via the lobby endpoint.
  // The /draftgroups/v1/draftgroups API returns 400 without filters and is
  // not a viable discovery surface; the lobby getcontests JSON is.
  let dgRes: Response;
  try {
    dgRes = await fetch("https://www.draftkings.com/lobby/getcontests?sport=NBA", {
      method: "GET",
      headers: DK_HEADERS,
    });
  } catch (err) {
    return jsonResponse(
      { error: "draftgroups_fetch_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
  if (!dgRes.ok) {
    const body = await dgRes.text().catch(() => "");
    return jsonResponse(
      { error: "draftgroups_upstream_failed", status: dgRes.status, body_excerpt: body.slice(0, 800) },
      502,
    );
  }

  let dgJson: DkLobbyResponse;
  try {
    dgJson = await dgRes.json();
  } catch (err) {
    return jsonResponse(
      { error: "draftgroups_not_json", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }

  const contests = dgJson.Contests ?? [];
  const draftGroupId = pickDraftGroupId(contests, todayET);
  if (draftGroupId == null) {
    // Distinguish "scrape worked but no NBA today" from upstream failure —
    // caller decides whether to log a benign skip vs an alert-worthy error.
    const empty: NormalizedDkResponse = {
      draftGroupId: null,
      gameDate: todayET,
      players: [],
      note: "no_nba_slate_today",
    };
    return jsonResponse(empty, 200, 600);
  }

  // Step B: fetch the draftables for that group.
  let dRes: Response;
  try {
    dRes = await fetch(`https://api.draftkings.com/draftgroups/v1/draftgroups/${draftGroupId}/draftables`, {
      method: "GET",
      headers: DK_HEADERS,
    });
  } catch (err) {
    return jsonResponse(
      {
        error: "draftables_fetch_failed",
        draftGroupId,
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
  if (!dRes.ok) {
    const body = await dRes.text().catch(() => "");
    return jsonResponse(
      {
        error: "draftables_upstream_failed",
        draftGroupId,
        status: dRes.status,
        body_excerpt: body.slice(0, 800),
      },
      502,
    );
  }

  let dJson: { draftables?: DkDraftable[] };
  try {
    dJson = await dRes.json();
  } catch (err) {
    return jsonResponse(
      { error: "draftables_not_json", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }

  // Step C: normalize.
  const players = normalizeDraftables(dJson.draftables ?? []);
  const normalized: NormalizedDkResponse = {
    draftGroupId,
    gameDate: todayET,
    players,
  };
  return jsonResponse(normalized, 200, 600);
}

// ─── /nba/odds (placeholder) ──────────────────────────────────────────────────
// Reserved for the Odds API integration. Once the API key arrives, wire
// https://api.the-odds-api.com/v4/sports/basketball_nba/odds through here
// (header `x-api-key`) and switch the handler to a pass-through similar to
// /nba/scoreboard. Bind the key as an additional worker secret (e.g.
// `wrangler secret put ODDS_API_KEY`) so it stays out of the repo.

function handleOdds(): Response {
  return jsonResponse({ error: "odds_route_pending_api_key" }, 501);
}

// ─── Worker entry ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    const auth = request.headers.get("X-Proxy-Secret");
    if (!auth || auth !== env.PROXY_SECRET) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const path = new URL(request.url).pathname.replace(/\/+$/g, "").toLowerCase();
    switch (path) {
      case "/nba/scoreboard":
        return handleScoreboard(request);
      case "/nba/draftkings-projections":
        return handleDraftKingsProjections(request);
      case "/nba/odds":
        return handleOdds();
      default:
        return jsonResponse({ error: "route_not_found", path }, 404);
    }
  },
};
