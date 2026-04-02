// lib/active-collection.ts
// Tracks the last-visited collection so other components (e.g. MobileNav)
// can build dynamic links without knowing the current route.

const STORAGE_KEY = "rpc_last_collection";
const DEFAULT_COLLECTION = "nba-top-shot";

export function getLastCollection(): string {
  if (typeof window === "undefined") return DEFAULT_COLLECTION;
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_COLLECTION;
  } catch {
    return DEFAULT_COLLECTION;
  }
}

export function setLastCollection(id: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
}
