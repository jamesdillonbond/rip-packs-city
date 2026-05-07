// Sports data proxy — bypasses Vercel/Supabase egress blocks against
// stats.nba.com and api.draftkings.com, and reserves a slot for
// the-odds-api.com (wired when the Odds API key arrives).
//
// Routes (all POST, all gated by X-Proxy-Secret matching env.PROXY_SECRET):
//   POST /nba/scoreboard               → stats.nba.com/stats/scoreboardV2 (pass-through)
//   POST /nba/draftkings-projections   → DraftKings draftgroups + draftables (normalized)
//   POST /nba/rolling-projections      → stats.nba.com last-5-games averages + DK fp formula
//   POST /nba/odds                     → 501 placeholder until the Odds API key
//
// Cache:
//   /nba/scoreboard             → 5 min  (stats.nba.com is the truth source for live scoring)
//   /nba/draftkings-projections → 10 min (DK refreshes salary / status throughout the day)
//   /nba/rolling-projections    → 10 min (rolling averages refresh after each completed game)
//   /nba/odds                   → none (501)
//
// Rolling-projections is the active replacement for DraftKings as of
// 2026-05-06 — Akamai started 403'ing api.draftkings.com regardless of
// header fingerprint. Stats.nba.com is more permissive and the rolling
// average is a reasonable stand-in until a real projection feed lands.
//
// 2026-05-07 hardening pass: rotate UA across a small pool, send the
// navigation-flavored sec-fetch-* family on the DK fetches, retry once
// on 403 with a fresh UA, and retry stats.nba.com 520s up to 3 attempts
// with exponential backoff (1s, 2s). Akamai had caught up to the fixed
// Chrome 124 fingerprint and was 403'ing 12 times per 24h.
//
// Same secret-rotation surface as topshot-proxy: PROXY_SECRET set via
// `wrangler secret put PROXY_SECRET` on this worker. Reuse the same value
// already stored in topshot-proxy's PROXY_SECRET so RPC env stays single-secret
// (each worker can be rotated independently later if needed).

interface Env {
  PROXY_SECRET: string;
}

// ─── Browser fingerprint pool ─────────────────────────────────────────────────
// Each entry is one self-consistent fingerprint snapshot taken from real
// Chrome devtools captures (network panel → copy as cURL). Mixing UA strings
// with mismatched sec-ch-ua values is itself a bot signal, so the pool keeps
// each combination atomic. Firefox / Safari entries omit sec-ch-ua (those
// browsers don't send Client Hints).
interface BrowserFingerprint {
  ua: string;
  secChUa?: string;
  secChUaPlatform: string;
}

const BROWSER_POOL: BrowserFingerprint[] = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    secChUa: "\"Not/A)Brand\";v=\"8\", \"Chromium\";v=\"126\", \"Google Chrome\";v=\"126\"",
    secChUaPlatform: "\"Windows\"",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    secChUa: "\"Not)A;Brand\";v=\"99\", \"Google Chrome\";v=\"127\", \"Chromium\";v=\"127\"",
    secChUaPlatform: "\"macOS\"",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    secChUa: "\"Chromium\";v=\"128\", \"Not;A=Brand\";v=\"24\", \"Google Chrome\";v=\"128\"",
    secChUaPlatform: "\"Windows\"",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    secChUaPlatform: "\"macOS\"",
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
    secChUaPlatform: "\"Windows\"",
  },
];

function pickFingerprint(exclude?: BrowserFingerprint): BrowserFingerprint {
  if (BROWSER_POOL.length === 1) return BROWSER_POOL[0];
  if (!exclude) return BROWSER_POOL[Math.floor(Math.random() * BROWSER_POOL.length)];
  // Pick a fingerprint other than the one we already tried so the retry
  // genuinely changes the bot fingerprint Akamai sees.
  const candidates = BROWSER_POOL.filter(f => f.ua !== exclude.ua);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// stats.nba.com expects a desktop browser fingerprint. The legacy worker
// captured Chrome 124 with the nba.com origin / referer; that still works,
// but we rotate the UA via the pool so we don't present a single signature
// across every request.
const NBA_HEADERS_BASE: Record<string, string> = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://www.nba.com",
  "Referer": "https://www.nba.com/",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
};

function nbaHeaders(fp: BrowserFingerprint): Record<string, string> {
  const h: Record<string, string> = {
    ...NBA_HEADERS_BASE,
    "User-Agent": fp.ua,
  };
  if (fp.secChUa) {
    h["Sec-Ch-Ua"] = fp.secChUa;
    h["Sec-Ch-Ua-Mobile"] = "?0";
    h["Sec-Ch-Ua-Platform"] = fp.secChUaPlatform;
  }
  return h;
}

// DraftKings (Akamai) — navigation-flavored fingerprint. 2026-05-06 the prior
// CORS/XHR fingerprint started 403'ing; navigation-style sec-fetch values
// pass Akamai's coherence check more reliably for the lobby URL because that
// URL ostensibly serves an HTML page. Accept stays `application/json` because
// the upstream still returns JSON regardless of Accept; flipping Accept to
// text/html caused the upstream to redirect to the marketing landing page.
function dkHeaders(fp: BrowserFingerprint): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": fp.ua,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.draftkings.com/lobby",
    "Origin": "https://www.draftkings.com",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
  if (fp.secChUa) {
    h["Sec-Ch-Ua"] = fp.secChUa;
    h["Sec-Ch-Ua-Mobile"] = "?0";
    h["Sec-Ch-Ua-Platform"] = fp.secChUaPlatform;
  }
  return h;
}

// fetchWithDkRetry — primary fetch wrapper for DK. On a 403 (Akamai bot
// rejection) sleep 5 seconds and retry once with a different fingerprint.
// 401s are also retried because they correlate with the same Akamai bucket
// when the lobby cookie set lacks the tracking values the UA is expected
// to carry.
async function fetchWithDkRetry(url: string): Promise<Response> {
  const fp1 = pickFingerprint();
  let res = await fetch(url, { method: "GET", headers: dkHeaders(fp1) });
  if (res.status === 403 || res.status === 401) {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    const fp2 = pickFingerprint(fp1);
    res = await fetch(url, { method: "GET", headers: dkHeaders(fp2) });
  }
  return res;
}

// fetchWithStatsRetry — stats.nba.com 520s sporadically (Cloudflare-on-
// Cloudflare origin issue). Retry up to 3 attempts with 1s / 2s backoff.
// Anything other than 5xx returns immediately so we don't burn budget on
// 4xx that won't change.
async function fetchWithStatsRetry(url: string, perAttemptTimeoutMs = 8_000): Promise<{ res: Response; attempts: number }> {
  const backoffs = [1_000, 2_000];
  let lastRes: Response | null = null;
  let fp = pickFingerprint();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: nbaHeaders(fp),
        signal: AbortSignal.timeout(perAttemptTimeoutMs),
      });
      lastRes = res;
      if (res.status < 500) return { res, attempts: attempt };
      // 5xx — back off and rotate fingerprint before retrying.
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, backoffs[attempt - 1]));
        fp = pickFingerprint(fp);
      }
    } catch (err) {
      // Network / timeout error. Treat like a 5xx for retry purposes.
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, backoffs[attempt - 1]));
        fp = pickFingerprint(fp);
        continue;
      }
      throw err;
    }
  }
  return { res: lastRes!, attempts: 3 };
}

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

  const { res: upstream, attempts } = await fetchWithStatsRetry(url.toString());
  const text = await upstream.text();

  if (!upstream.ok) {
    return jsonResponse(
      {
        error: "upstream_failed",
        status: upstream.status,
        attempts,
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

interface NormalizedGame {
  gameId: string;
  name: string;
  homeAbbr: string | null;
  awayAbbr: string | null;
  startTime: string | null;
  gameDate: string | null;
}

interface NormalizedDkResponse {
  draftGroupId: number | null;
  gameDate: string;
  players: NormalizedPlayer[];
  games: NormalizedGame[];
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

function dateInETFromIso(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return dateInETFromMs(ms);
}

function parseCompetitionTeams(name: string | undefined | null): { homeAbbr: string | null; awayAbbr: string | null } {
  if (!name) return { homeAbbr: null, awayAbbr: null };
  // DK competition.name comes through as "MIN @ SAS" (away @ home). Some legacy
  // contests still use " vs " — accept either, but for "@" the right-hand
  // token is always the home team.
  const at = name.match(/^\s*([A-Z]{2,4})\s*@\s*([A-Z]{2,4})\s*$/i);
  if (at) return { homeAbbr: at[2].toUpperCase(), awayAbbr: at[1].toUpperCase() };
  const vs = name.match(/^\s*([A-Z]{2,4})\s+vs\.?\s+([A-Z]{2,4})\s*$/i);
  if (vs) return { homeAbbr: vs[2].toUpperCase(), awayAbbr: vs[1].toUpperCase() };
  return { homeAbbr: null, awayAbbr: null };
}

function extractGames(draftables: DkDraftable[]): NormalizedGame[] {
  // Each draftable is one (player, eligible roster slot); the same competition
  // shows up many times. Dedupe by competitionId so each game ships once.
  const seen = new Map<string, NormalizedGame>();
  for (const d of draftables) {
    const comp = d.competition;
    const cid = comp?.competitionId;
    if (cid == null) continue;
    const key = String(cid);
    if (seen.has(key)) continue;
    const { homeAbbr, awayAbbr } = parseCompetitionTeams(comp?.name);
    seen.set(key, {
      gameId: key,
      name: (comp?.name ?? "").trim(),
      homeAbbr,
      awayAbbr,
      startTime: comp?.startTime ?? null,
      gameDate: dateInETFromIso(comp?.startTime ?? null),
    });
  }
  return [...seen.values()];
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
    dgRes = await fetchWithDkRetry("https://www.draftkings.com/lobby/getcontests?sport=NBA");
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
      games: [],
      note: "no_nba_slate_today",
    };
    return jsonResponse(empty, 200, 600);
  }

  // Step B: fetch the draftables for that group.
  let dRes: Response;
  try {
    dRes = await fetchWithDkRetry(`https://api.draftkings.com/draftgroups/v1/draftgroups/${draftGroupId}/draftables`);
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
  const draftables = dJson.draftables ?? [];
  const players = normalizeDraftables(draftables);
  const games = extractGames(draftables);
  const normalized: NormalizedDkResponse = {
    draftGroupId,
    gameDate: todayET,
    players,
    games,
  };
  return jsonResponse(normalized, 200, 600);
}

// ─── /nba/rolling-projections ─────────────────────────────────────────────────
// stats.nba.com replacement for DraftKings. Two upstreams:
//   - cdn.nba.com (S3-served static scoreboard JSON) — open to CF Workers,
//     authoritative for today's slate. Returns gameId + team tricodes + UTC
//     tipoff. This is the primary writer for nba_games rows.
//   - stats.nba.com leaguedashplayerstats — last-5-games per-game averages.
//     Sporadic 520s from CF Worker IPs (origin-side CF block). The route
//     keeps it on the request path as best-effort: when it lands, full DK
//     fantasy projections ship; when it 520s after retries, the response
//     carries games-only with a degraded `note` so pipeline_runs records
//     the partial state.
// DK fantasy points are computed from the rolling averages with the standard
// DraftKings formula:
//   fp = pts + 1.2*reb + 1.5*ast + 3*stl + 3*blk - tov
//        + 1.5*(dd2/gp) + 3*(td3/gp)
// DD2/TD3 are totals over the last-N window — divide by GP for per-game
// frequency. The bonus is approximate when applied to averaged rows; it
// stays small relative to the base score and is acceptable as a stand-in
// projection until a non-CF ingress for stats.nba.com is in place.

const NBA_TEAM_ID_TO_ABBR: Record<string, string> = {
  "1610612737": "ATL", "1610612738": "BOS", "1610612739": "CLE", "1610612740": "NOP",
  "1610612741": "CHI", "1610612742": "DAL", "1610612743": "DEN", "1610612744": "GSW",
  "1610612745": "HOU", "1610612746": "LAC", "1610612747": "LAL", "1610612748": "MIA",
  "1610612749": "MIL", "1610612750": "MIN", "1610612751": "BKN", "1610612752": "NYK",
  "1610612753": "ORL", "1610612754": "IND", "1610612755": "PHI", "1610612756": "PHX",
  "1610612757": "POR", "1610612758": "SAC", "1610612759": "SAS", "1610612760": "OKC",
  "1610612761": "TOR", "1610612762": "UTA", "1610612763": "MEM", "1610612764": "WAS",
  "1610612765": "DET", "1610612766": "CHA",
};

interface NbaResultSet {
  name: string;
  headers: string[];
  rowSet: unknown[][];
}

interface NbaApiResponse {
  resultSets?: NbaResultSet[];
}

function nbaSeasonStringFromETDate(etDate: string): string {
  // etDate is YYYY-MM-DD. NBA seasons run Oct (year N) through Jun (year N+1).
  // Months Jul–Sep have no NBA games, but pinning to the most-recent season
  // keeps the request shape valid even on an off-day.
  const [yStr, mStr] = etDate.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const startYear = m >= 10 ? y : y - 1;
  const endYY = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYY}`;
}

function nbaSeasonTypeFromETDate(etDate: string): "Playoffs" | "Regular Season" {
  // Mid-April → mid-June is Playoffs; rest of the season is Regular Season.
  // Off-season (Jul–Sep) returns Regular Season as a harmless default — the
  // upstream returns an empty rowSet, which we surface as no-slate-today.
  const [_, mStr, dStr] = etDate.split("-");
  const m = parseInt(mStr, 10);
  const d = parseInt(dStr, 10);
  if (m === 4 && d >= 15) return "Playoffs";
  if (m === 5 || m === 6) return "Playoffs";
  return "Regular Season";
}

function buildPlayerStatsUrl(season: string, seasonType: "Regular Season" | "Playoffs"): string {
  const url = new URL("https://stats.nba.com/stats/leaguedashplayerstats");
  // The endpoint requires every parameter, even when empty. Missing params
  // produce a 400 with "The field <X> is required". Filled exactly the way
  // the official site does.
  const params: Record<string, string> = {
    College: "",
    Conference: "",
    Country: "",
    DateFrom: "",
    DateTo: "",
    Division: "",
    DraftPick: "",
    DraftYear: "",
    GameScope: "",
    GameSegment: "",
    Height: "",
    LastNGames: "5",
    LeagueID: "00",
    Location: "",
    MeasureType: "Base",
    Month: "0",
    OpponentTeamID: "0",
    Outcome: "",
    PORound: "0",
    PaceAdjust: "N",
    PerMode: "PerGame",
    Period: "0",
    PlayerExperience: "",
    PlayerPosition: "",
    PlusMinus: "N",
    Rank: "N",
    Season: season,
    SeasonSegment: "",
    SeasonType: seasonType,
    ShotClockRange: "",
    StarterBench: "",
    TeamID: "0",
    VsConference: "",
    VsDivision: "",
    Weight: "",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

interface RollingPlayer {
  name: string;
  teamAbbr: string | null;
  position: string | null;
  salary: number | null;
  status: string | null;
  projFp: number | null;
  proj_points: number | null;
  proj_rebounds: number | null;
  proj_assists: number | null;
  proj_threes: number | null;
  proj_steals: number | null;
  proj_blocks: number | null;
  proj_turnovers: number | null;
  proj_minutes: number | null;
  opponentAbbr: string | null;
  gameStartTime: string | null;
  gp: number | null;
}

function parsePlayerStats(json: NbaApiResponse): RollingPlayer[] {
  const set = (json.resultSets ?? []).find(s => s.name === "LeagueDashPlayerStats");
  if (!set) return [];
  const idx = (h: string) => set.headers.indexOf(h);
  const iName = idx("PLAYER_NAME");
  const iTeam = idx("TEAM_ABBREVIATION");
  const iGP = idx("GP");
  const iMin = idx("MIN");
  const iPts = idx("PTS");
  const iReb = idx("REB");
  const iAst = idx("AST");
  const iTov = idx("TOV");
  const iStl = idx("STL");
  const iBlk = idx("BLK");
  const iThree = idx("FG3M");
  const iDD2 = idx("DD2");
  const iTD3 = idx("TD3");

  const out: RollingPlayer[] = [];
  for (const row of set.rowSet ?? []) {
    const name = String(row[iName] ?? "").trim();
    if (!name) continue;
    const team = String(row[iTeam] ?? "").trim() || null;
    const num = (i: number): number | null => {
      if (i < 0) return null;
      const v = row[i];
      if (v == null) return null;
      const n = typeof v === "number" ? v : parseFloat(String(v));
      return Number.isFinite(n) ? n : null;
    };
    const gp = num(iGP);
    const pts = num(iPts);
    const reb = num(iReb);
    const ast = num(iAst);
    const tov = num(iTov);
    const stl = num(iStl);
    const blk = num(iBlk);
    const three = num(iThree);
    const min = num(iMin);
    const dd2 = num(iDD2);
    const td3 = num(iTD3);

    let projFp: number | null = null;
    if (pts != null && reb != null && ast != null && stl != null && blk != null && tov != null) {
      const ddRate = gp && gp > 0 && dd2 != null ? dd2 / gp : 0;
      const tdRate = gp && gp > 0 && td3 != null ? td3 / gp : 0;
      projFp = pts + 1.2 * reb + 1.5 * ast + 3 * stl + 3 * blk - tov + 1.5 * ddRate + 3 * tdRate;
      projFp = Math.round(projFp * 100) / 100;
    }

    out.push({
      name,
      teamAbbr: team,
      position: null,
      salary: null,
      status: null,
      projFp,
      proj_points: pts,
      proj_rebounds: reb,
      proj_assists: ast,
      proj_threes: three,
      proj_steals: stl,
      proj_blocks: blk,
      proj_turnovers: tov,
      proj_minutes: min,
      opponentAbbr: null,
      gameStartTime: null,
      gp,
    });
  }
  return out;
}

interface CdnScoreboardTeam {
  teamId?: number;
  teamTricode?: string;
}

interface CdnScoreboardGame {
  gameId?: string;
  gameTimeUTC?: string;
  homeTeam?: CdnScoreboardTeam;
  awayTeam?: CdnScoreboardTeam;
}

interface CdnScoreboardResponse {
  scoreboard?: {
    gameDate?: string;
    games?: CdnScoreboardGame[];
  };
}

function parseCdnScoreboardGames(json: CdnScoreboardResponse, etDate: string): NormalizedGame[] {
  const games = json?.scoreboard?.games ?? [];
  const sourceDate = json?.scoreboard?.gameDate ?? etDate;
  const out: NormalizedGame[] = [];
  for (const g of games) {
    const gameId = (g.gameId ?? "").toString().trim();
    if (!gameId) continue;
    const home = g.homeTeam?.teamTricode?.trim().toUpperCase() ?? null;
    const away = g.awayTeam?.teamTricode?.trim().toUpperCase() ?? null;
    if (!home || !away) continue;
    out.push({
      gameId,
      name: `${away} @ ${home}`,
      homeAbbr: home,
      awayAbbr: away,
      startTime: g.gameTimeUTC ?? null,
      gameDate: sourceDate,
    });
  }
  return out;
}

function attachOpponents(players: RollingPlayer[], games: NormalizedGame[]): RollingPlayer[] {
  // For each player on a team that's playing today, attach the opponent abbr
  // so the edge function's findGameForTeam() can fall through if it ever
  // skips the games-table lookup. The primary binding still goes via
  // nba_games on the supabase side; this is best-effort metadata.
  const teamToOpp = new Map<string, string>();
  for (const g of games) {
    if (g.homeAbbr && g.awayAbbr) {
      teamToOpp.set(g.homeAbbr, g.awayAbbr);
      teamToOpp.set(g.awayAbbr, g.homeAbbr);
    }
  }
  return players.map(p => ({
    ...p,
    opponentAbbr: p.teamAbbr ? teamToOpp.get(p.teamAbbr.toUpperCase()) ?? null : null,
  }));
}

async function handleRollingProjections(_request: Request): Promise<Response> {
  const todayET = todayInET();
  const season = nbaSeasonStringFromETDate(todayET);
  const seasonType = nbaSeasonTypeFromETDate(todayET);

  // Two upstreams:
  //   1. cdn.nba.com — static S3 mirror of today's scoreboard. Open to CF
  //      Workers (no WAF), returns clean JSON with team tricodes + tipoff UTC.
  //      This is the primary source of nba_games rows.
  //   2. stats.nba.com — last-5-games per-game averages. Sporadic 520s from
  //      CF Workers. Wrapped in fetchWithStatsRetry (3 attempts, exponential
  //      backoff). When it 520s every time, we ship games-only with players=[]
  //      and a note explaining the degraded state.
  // Result: nba_games stays fresh even when projections are unavailable.

  const cdnUrl = "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json";
  const cdnFp = pickFingerprint();
  const cdnHeaders: Record<string, string> = {
    "User-Agent": cdnFp.ua,
    "Accept": "application/json, text/plain, */*",
  };

  // Fire scoreboard + player-stats concurrently. Player-stats uses retry
  // wrapper internally; scoreboard rarely fails so a single attempt is fine.
  const [sbResult, psResult] = await Promise.allSettled([
    fetch(cdnUrl, { method: "GET", headers: cdnHeaders, signal: AbortSignal.timeout(12_000) }),
    fetchWithStatsRetry(buildPlayerStatsUrl(season, seasonType)),
  ]);

  if (sbResult.status === "rejected") {
    return jsonResponse(
      { error: "scoreboard_fetch_failed", message: String((sbResult as PromiseRejectedResult).reason) },
      502,
    );
  }
  const sbRes = sbResult.value;
  if (!sbRes.ok) {
    const body = await sbRes.text().catch(() => "");
    return jsonResponse(
      { error: "scoreboard_upstream_failed", status: sbRes.status, body_excerpt: body.slice(0, 800) },
      502,
    );
  }
  let sbJson: CdnScoreboardResponse;
  try { sbJson = await sbRes.json(); } catch (err) {
    return jsonResponse(
      { error: "scoreboard_not_json", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
  const games = parseCdnScoreboardGames(sbJson, todayET);

  if (games.length === 0) {
    const empty: NormalizedDkResponse = {
      draftGroupId: null,
      gameDate: todayET,
      players: [],
      games: [],
      note: "no_nba_slate_today",
    };
    return jsonResponse(empty, 200, 600);
  }

  // Player stats — best-effort with retry. stats.nba.com's 520s are CF-on-CF
  // origin issues; rotating the fingerprint between retries occasionally
  // recovers, otherwise we ship games-only with a degradation note.
  let players: RollingPlayer[] = [];
  let degradedNote: string | undefined;
  let degradedStatus: number | null = null;
  let psAttempts: number | null = null;

  if (psResult.status === "rejected") {
    degradedNote = "playerstats_fetch_failed";
  } else {
    const { res: psRes, attempts } = psResult.value;
    psAttempts = attempts;
    if (!psRes.ok) {
      degradedNote = `playerstats_upstream_blocked_after_${attempts}_attempts`;
      degradedStatus = psRes.status;
    } else {
      let psJson: NbaApiResponse | null = null;
      try { psJson = await psRes.json(); } catch { degradedNote = "playerstats_not_json"; }
      if (psJson) {
        players = parsePlayerStats(psJson);
        if (players.length === 0) degradedNote = "playerstats_empty";
        else players = attachOpponents(players, games);
      }
    }
  }

  const normalized: NormalizedDkResponse & {
    source: string;
    season: string;
    seasonType: string;
    upstreamPlayerStatusOnDegrade?: number | null;
    playerStatsAttempts?: number | null;
  } = {
    draftGroupId: null,
    gameDate: todayET,
    players,
    games,
    source: "nba-stats-rolling5",
    season,
    seasonType,
    note: degradedNote,
    upstreamPlayerStatusOnDegrade: degradedStatus,
    playerStatsAttempts: psAttempts,
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
      case "/nba/rolling-projections":
        return handleRollingProjections(request);
      case "/nba/odds":
        return handleOdds();
      default:
        return jsonResponse({ error: "route_not_found", path }, 404);
    }
  },
};
