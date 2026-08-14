// lib/serials/fun-patterns.ts
//
// "Quirky serial" classification — palindromes, repdigits, meme numbers, a
// serial that matches the player's jersey / birthday / draft year, or the area
// code of the team's city. Requested 2026-08-13: collectors chase these, and
// nothing on RPC surfaces them.
//
// ⚠ THIS IS DELIBERATELY SEPARATE FROM `specialSerialTraits`, AND MUST STAY
// SEPARATE. That array feeds `applySerialPremium` in lib/market-analytics.ts,
// where "#1 Serial" multiplies value by 1.35, "Perfect Mint" by 1.18, "Jersey
// Match" by 1.2. Those multipliers encode OBSERVED market premium. The patterns
// in this file are NOVELTY — a serial being 420, or reading the same backwards,
// is a fun fact, not a demonstrated price effect. Folding these into
// `specialSerialTraits` would silently move FMV for thousands of moments on the
// strength of a joke. If a premium is ever wanted for one of these, it must be
// MEASURED against sales first and moved deliberately, not inherited by being
// put in the same array.
//
// Everything here is a pure function over numbers RPC already stores
// (`serial_number`, `circulation_count`), plus OPTIONAL context the caller
// supplies. Nothing fetches. That keeps it in the primary coverage gate and
// makes every pattern trivially checkable — which matters, because the whole
// value of this feature is that a claim like "this is a palindrome" is either
// true or it isn't.

/** A single quirky property found on a serial number. */
export interface SerialQuirk {
  /** Stable machine key — safe to persist, filter, or index on. */
  kind:
    | "palindrome"
    | "repdigit"
    | "sequential"
    | "round"
    | "meme"
    | "jersey_match"
    | "birthday_match"
    | "draft_year_match"
    | "area_code_match"
    | "first_serial"
    | "last_serial";
  /** Short human label for a chip or a chat reply. */
  label: string;
  /**
   * Why this serial qualifies, in words a collector can verify at a glance.
   * Present on every quirk because an unexplained claim invites "says who?" —
   * and because several of these are only true relative to context the reader
   * cannot see (a birthdate, a jersey number, an area code).
   */
  why: string;
}

/** Optional per-moment context. Every field is independent and may be absent. */
export interface SerialContext {
  /** Edition circulation, for first/last-serial detection. */
  circulationCount?: number | null;
  /** Player jersey number — Top Shot exposes this on PlayStats. */
  jerseyNumber?: number | string | null;
  /** ISO date (YYYY-MM-DD). Top Shot exposes `birthdate` on PlayStats. */
  birthdate?: string | null;
  /** Top Shot exposes `draftYear` on PlayStats. */
  draftYear?: number | null;
  /**
   * Area codes for the team's city, supplied by the CALLER.
   *
   * ⚠ Deliberately a parameter rather than a table baked into this file. A
   * team→area-code map is real data with real ambiguity (most metros have
   * several codes; "the team's city" is genuinely unclear for Golden State or
   * the New York teams), and an unverified map would produce confident wrong
   * claims — the exact failure this module's `why` field exists to prevent.
   * Author and verify that map separately, then pass it in.
   */
  areaCodes?: number[] | null;
}

/** Meme numbers collectors actually hunt. Kept short and uncontroversial. */
const MEME_SERIALS = new Map<number, string>([
  [69, "69"],
  [420, "420"],
  [666, "666"],
  [1337, "1337 (leet)"],
  [8, "8 (lucky 8)"],
  [7, "7 (lucky 7)"],
]);

function isPalindrome(n: number): boolean {
  const s = String(n);
  // Single digits are trivially palindromic; that is noise, not a find.
  if (s.length < 2) return false;
  return s === [...s].reverse().join("");
}

function isRepdigit(n: number): boolean {
  const s = String(n);
  if (s.length < 2) return false;
  return new Set(s).size === 1;
}

/** 123, 1234, 4321 — ascending or descending runs of length >= 3. */
function isSequential(n: number): boolean {
  const s = String(n);
  if (s.length < 3) return false;
  const d = [...s].map(Number);
  const asc = d.every((v, i) => i === 0 || v === d[i - 1] + 1);
  const desc = d.every((v, i) => i === 0 || v === d[i - 1] - 1);
  return asc || desc;
}

/** 100, 1000, 5000 — a trailing-zero round number, at least 3 digits. */
function isRound(n: number): boolean {
  return n >= 100 && n % 100 === 0;
}

/**
 * Does the serial match the player's birthday?
 *
 * Accepts the two conventions collectors actually use: MMDD (617 for June 17,
 * 1217 for December 17) and DDMM. Both are reported with the reading spelled
 * out in `why`, because "matches their birthday" is unverifiable on its face.
 */
function birthdayMatches(serial: number, iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!month || !day) return null;
  const mmdd = month * 100 + day;
  const ddmm = day * 100 + month;
  if (serial === mmdd) return `born ${m[1]}-${m[2]}-${m[3]} — serial reads as ${m[2]}/${m[3]} (MM/DD)`;
  if (serial === ddmm) return `born ${m[1]}-${m[2]}-${m[3]} — serial reads as ${m[3]}/${m[2]} (DD/MM)`;
  return null;
}

/**
 * Classify a serial number.
 *
 * @param serial the moment's serial number
 * @param ctx    optional context; absent fields simply yield no quirk
 * @returns every quirk that applies, most distinctive first. Empty when the
 *          serial is ordinary — an empty array is a real answer, not a failure.
 */
export function classifySerial(
  serial: number | null | undefined,
  ctx: SerialContext = {}
): SerialQuirk[] {
  if (serial == null || !Number.isFinite(serial) || serial <= 0 || !Number.isInteger(serial)) {
    return [];
  }

  const out: SerialQuirk[] = [];
  const circ = ctx.circulationCount ?? null;

  if (serial === 1) {
    out.push({ kind: "first_serial", label: "#1", why: "the first serial minted for this edition" });
  }
  if (circ != null && circ > 1 && serial === circ) {
    out.push({ kind: "last_serial", label: "Last mint", why: `the final serial of ${circ}` });
  }

  // Jersey match. Compared numerically so "05" and 5 agree.
  const jersey = ctx.jerseyNumber == null ? null : Number(ctx.jerseyNumber);
  if (jersey != null && Number.isFinite(jersey) && jersey > 0 && serial === jersey) {
    out.push({ kind: "jersey_match", label: "Jersey match", why: `their jersey number is ${jersey}` });
  }

  if (ctx.birthdate) {
    const why = birthdayMatches(serial, ctx.birthdate);
    if (why) out.push({ kind: "birthday_match", label: "Birthday", why });
  }

  if (ctx.draftYear && serial === ctx.draftYear) {
    out.push({ kind: "draft_year_match", label: "Draft year", why: `drafted in ${ctx.draftYear}` });
  }

  if (ctx.areaCodes && ctx.areaCodes.includes(serial)) {
    out.push({ kind: "area_code_match", label: "Area code", why: `${serial} is an area code for this team's city` });
  }

  if (isRepdigit(serial)) {
    // Reported as repdigit rather than palindrome: 888 is both, and "all the
    // same digit" is the stronger, more specific statement.
    out.push({ kind: "repdigit", label: "Repdigit", why: `every digit is ${String(serial)[0]}` });
  } else if (isPalindrome(serial)) {
    out.push({ kind: "palindrome", label: "Palindrome", why: `${serial} reads the same backwards` });
  }

  if (isSequential(serial)) {
    out.push({ kind: "sequential", label: "Sequential", why: `${serial} runs in order` });
  }

  const meme = MEME_SERIALS.get(serial);
  if (meme) {
    out.push({ kind: "meme", label: meme, why: `serial ${serial}` });
  }

  // Round numbers are the weakest signal, and a repdigit/sequential serial is
  // never also round, so this cannot double-report the same idea.
  if (isRound(serial)) {
    out.push({ kind: "round", label: "Round number", why: `${serial} is a round number` });
  }

  return out;
}

/** True when a serial has any quirk at all — a cheap filter for a board query. */
export function hasQuirk(serial: number | null | undefined, ctx: SerialContext = {}): boolean {
  return classifySerial(serial, ctx).length > 0;
}
