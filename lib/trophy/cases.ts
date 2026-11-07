// lib/trophy/cases.ts
//
// Multiple trophy cases (2026-11-06). The MAIN case is every trophy_moments row
// with case_id NULL; additional cases live in trophy_cases (a named case, or an
// entry in a trophy_challenges row).
//
// ⚠ EVERY (user_id, slot) READ OR WRITE MUST BE SCOPED BY case_id. Before this
// feature a user had one case, so `.eq("user_id").eq("slot")` named one row.
// Now it names one row PER CASE: an unpin of main-case slot 1 would also delete
// a challenge entry's slot 1. `scopeToCase` is the one place that scoping lives.

/** Most extra cases one collector may create (the main case not counted). */
export const MAX_EXTRA_CASES = 10;
export const MAX_CASE_NAME_LEN = 40;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalise a client-supplied case id. `undefined`/`null`/"" = the main case.
 * Returns `false` for a value that is present but not a uuid (a 400).
 */
export function parseCaseId(raw: unknown): string | null | false {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !UUID_RE.test(raw)) return false;
  return raw.toLowerCase();
}

/** Collapse whitespace; null when empty or too long. */
export function cleanCaseName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.length === 0 || s.length > MAX_CASE_NAME_LEN) return null;
  return s;
}

/** Apply the case scope to a supabase-js filter builder. */
export function scopeToCase<T extends { is: (c: string, v: null) => T; eq: (c: string, v: string) => T }>(
  q: T,
  caseId: string | null
): T {
  return caseId == null ? q.is("case_id", null) : q.eq("case_id", caseId);
}

export interface OwnCase {
  id: string;
  name: string;
  challenge: { id: string; slug: string; title: string; rules: unknown; is_active: boolean; starts_at: string | null; ends_at: string | null } | null;
}

export type OwnCaseResult =
  | { ok: true; case: OwnCase | null }
  | { ok: false; error: unknown };

/**
 * Load a case the user OWNS. `case: null` = no such case for this user (a 404 —
 * a case id that exists under someone else is indistinguishable on purpose).
 */
export async function loadOwnCase(db: any, userId: string, caseId: string): Promise<OwnCaseResult> {
  const res = await db
    .from("trophy_cases")
    .select("id, name, challenge_id, trophy_challenges(id, slug, title, rules, is_active, starts_at, ends_at)")
    .eq("id", caseId)
    .eq("user_id", userId)
    .limit(1);
  if (res.error) return { ok: false, error: res.error };
  const row = (res.data ?? [])[0] as Record<string, any> | undefined;
  if (!row) return { ok: true, case: null };
  const ch = Array.isArray(row.trophy_challenges) ? row.trophy_challenges[0] : row.trophy_challenges;
  return {
    ok: true,
    case: {
      id: row.id,
      name: row.name,
      challenge: ch
        ? {
            id: ch.id,
            slug: ch.slug,
            title: ch.title,
            rules: ch.rules,
            is_active: ch.is_active === true,
            starts_at: ch.starts_at ?? null,
            ends_at: ch.ends_at ?? null,
          }
        : null,
    },
  };
}

/**
 * A challenge is open when active, started, and not past its end.
 * `starts_at` is REQUIRED in the type (2026-11-07 review): the rule ignored it,
 * so a challenge seeded for next week took entries today — and an optional
 * field would let a caller drop it again without a type error.
 */
export function challengeIsOpen(
  ch: { is_active: boolean; starts_at: string | null; ends_at: string | null },
  now = Date.now()
): boolean {
  if (!ch.is_active) return false;
  if (ch.starts_at && Date.parse(ch.starts_at) > now) return false;
  if (ch.ends_at && Date.parse(ch.ends_at) <= now) return false;
  return true;
}

/**
 * A case entered in a challenge that is no longer open is READ-ONLY — every write
 * verb (pin, unpin, caption, reorder) answers 409, not only the pin (2026-11-07
 * review: unpin / caption / reorder still changed an ended board). `null` = the
 * write may proceed (main case, a plain extra case, or an open challenge).
 */
export function refuseClosedChallenge(own: OwnCase | null, now = Date.now()): Response | null {
  const ch = own?.challenge ?? null;
  if (!ch || challengeIsOpen(ch, now)) return null;
  return Response.json({ error: `${ch.title} isn't open — this case is read-only.` }, { status: 409 });
}

