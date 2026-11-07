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

// Same-tab subscribers (useSyncExternalStore in TopNav): a `storage` event only
// fires in OTHER tabs, so setLastCollection notifies this one itself.
const listeners = new Set<() => void>();

export function setLastCollection(id: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
  for (const l of listeners) l();
}

export function subscribeLastCollection(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) cb(); };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

// The last-visited collection ONLY when one was actually recorded — null
// otherwise. `getLastCollection` substitutes Top Shot, which is right for a
// link that must go somewhere and wrong for copy that says "jump back to…":
// a first-time visitor never visited Top Shot.
export function readRecordedLastCollection(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}
