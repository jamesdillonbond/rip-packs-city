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

export function setAdminToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(RPC_ADMIN_TOKEN_STORAGE, token);
  } catch {}
}

export function clearAdminToken(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(RPC_ADMIN_TOKEN_STORAGE);
  } catch {}
}
