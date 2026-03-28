// lib/owner-key.ts
// Shared utility for reading and writing the RPC profile key from localStorage.
// Used by wallet, sets, sniper, packs pages to auto-populate the signed-in user.

export const OWNER_KEY_STORAGE = "rpc_owner_key";

export function getOwnerKey(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(OWNER_KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function setOwnerKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OWNER_KEY_STORAGE, key);
  } catch {}
}

export function clearOwnerKey(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(OWNER_KEY_STORAGE);
  } catch {}
}

// Subscribe to changes from other tabs.
// Returns an unsubscribe function.
export function onOwnerKeyChange(callback: (key: string) => void): () => void {
  if (typeof window === "undefined") return function() {};
  function handler(e: StorageEvent) {
    if (e.key === OWNER_KEY_STORAGE) {
      callback(e.newValue ?? "");
    }
  }
  window.addEventListener("storage", handler);
  return function() { window.removeEventListener("storage", handler); };
}