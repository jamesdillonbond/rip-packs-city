// lib/admin-token.ts
// Client-side helper for the Trevor-only /admin/feedback triage page.
// Mirrors lib/owner-key.ts. The token is paired against RPC_ADMIN_TOKEN on
// the server (lib/admin-auth.ts) and is sent as `Authorization: Bearer ${token}`.

export const RPC_ADMIN_TOKEN_STORAGE = "rpc_admin_token";

export function getAdminToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(RPC_ADMIN_TOKEN_STORAGE) ?? "";
  } catch {
    return "";
  }
}

/**
 * Persist an admin credential — ONLY a short-lived session (2026-10-27). toAdminSession hands back the MASTER
 * token when the exchange fails (so sign-in never locks the operator out), and every page wrote that straight to
 * localStorage, where any XSS on the origin could read it until a manual rotation. Now a non-session value is
 * never stored: the stored key is cleared and the caller keeps the master in memory for that page only.
 */
export function setAdminToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    if (isAdminSessionValue(token)) localStorage.setItem(RPC_ADMIN_TOKEN_STORAGE, token);
    else localStorage.removeItem(RPC_ADMIN_TOKEN_STORAGE);
  } catch {}
}

export function clearAdminToken(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(RPC_ADMIN_TOKEN_STORAGE);
  } catch {}
}

// ── Short-lived sessions (security audit 2026-10-25, R134 step 2) ───────────
// The pages store a 12-hour signed session (lib/admin-session.ts), never the
// master RPC_ADMIN_TOKEN. Exchange happens once, at sign-in.
export const ADMIN_SESSION_PREFIX_CLIENT = "rpcadm1.";

/** True for a short-lived signed session — the only admin credential that may be persisted in the browser. */
export function isAdminSessionValue(v: string | null | undefined): boolean {
  return typeof v === "string" && v.startsWith(ADMIN_SESSION_PREFIX_CLIENT);
}

/**
 * Exchange the master token for a session. Resolves to the SESSION on success;
 * if the exchange itself fails (network, an older deploy without the route)
 * it resolves to the value it was given, so sign-in never locks the operator
 * out — the master token is still accepted everywhere it was before.
 */
export async function toAdminSession(master: string): Promise<string> {
  const t = master.trim();
  if (!t || t.startsWith(ADMIN_SESSION_PREFIX_CLIENT)) return t;
  try {
    const res = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t }),
      cache: "no-store",
    });
    if (!res.ok) return t;
    const body = (await res.json()) as { session?: unknown };
    return typeof body.session === "string" && body.session.startsWith(ADMIN_SESSION_PREFIX_CLIENT) ? body.session : t;
  } catch {
    return t;
  }
}

/**
 * One-time upgrade for a browser that still holds the MASTER token from before
 * sessions existed: swap it in place for a session. Every admin page calls this
 * on mount; a no-op when the stored value is already a session or absent.
 */
export async function upgradeStoredAdminToken(): Promise<void> {
  if (typeof window === "undefined") return;
  let stored = "";
  try {
    stored = localStorage.getItem(RPC_ADMIN_TOKEN_STORAGE) ?? "";
  } catch {
    return;
  }
  if (!stored || stored.startsWith(ADMIN_SESSION_PREFIX_CLIENT)) return;
  // A stored MASTER token is swapped for a session, or — if the exchange fails — removed (2026-10-27): the master
  // must not sit in storage. The operator signs in again on that page.
  setAdminToken(await toAdminSession(stored));
}
