const TOPSHOT_GRAPHQL_URL = "https://public-api.nbatopshot.com/graphql";

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

// Opt-in 429 resilience (added 2026-07-03 for topshot-sales-history-backfill,
// which was hard-rate-limited on virtually every call). DEFAULT OFF — when
// `retryOn429` is unset the function behaves byte-identically to before, so no
// existing caller (sniper-feed, badge-sync, …) changes behavior. Only the
// backfill opts in.
export interface TopshotGraphqlOptions {
  /** Retry HTTP 429 responses honoring `Retry-After`, else exponential backoff. */
  retryOn429?: boolean;
  /** Max retry attempts after the first try (default 3). */
  maxRetries?: number;
  /** Upper bound on any single backoff sleep, ms — caps a hostile Retry-After (default 20000). */
  maxBackoffMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Retry-After is either delta-seconds ("120") or an HTTP-date. Return ms to wait,
// or null when absent/unparseable so the caller falls back to exponential backoff.
function parseRetryAfterMs(v: string | null): number | null {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const dateMs = Date.parse(v);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

export async function topshotGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
  opts?: TopshotGraphqlOptions
): Promise<T> {
  const retryOn429 = opts?.retryOn429 === true;
  const maxRetries = opts?.maxRetries ?? 3;
  const maxBackoffMs = opts?.maxBackoffMs ?? 20_000;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await fetch(TOPSHOT_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "sports-collectible-tool/0.1",
      },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });

    const rawText = await response.text();

    let json: GraphQLResponse<T> | null = null;
    try {
      json = JSON.parse(rawText) as GraphQLResponse<T>;
    } catch {
      json = null;
    }

    if (!response.ok) {
      // Bounded backoff on rate-limit, opt-in only. Honor Retry-After when the
      // server sends it, otherwise exponential (2s, 4s, 8s…) with jitter, both
      // capped by maxBackoffMs so a caller's lambda budget stays bounded.
      if (response.status === 429 && retryOn429 && attempt < maxRetries) {
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"));
        const backoff =
          retryAfter != null
            ? Math.min(retryAfter, maxBackoffMs)
            : Math.min(2000 * 2 ** attempt, maxBackoffMs);
        const jitter = Math.floor(Math.random() * 400);
        await sleep(backoff + jitter);
        attempt++;
        continue;
      }
      throw new Error(
        `Top Shot GraphQL failed with ${response.status}. Response body: ${rawText}`
      );
    }

    if (json?.errors?.length) {
      throw new Error(
        json.errors.map((error) => error.message).filter(Boolean).join("; ")
      );
    }

    if (!json?.data) {
      throw new Error(`Top Shot GraphQL returned no data. Raw body: ${rawText}`);
    }

    return json.data;
  }
}