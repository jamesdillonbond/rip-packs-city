// lib/tracked-collections.ts
// Manages the list of collection IDs the user is actively tracking.
// Stored in localStorage under rpc_tracked_collections as a JSON array.

const STORAGE_KEY = "rpc_tracked_collections";
const DEFAULT_COLLECTIONS = ["nba-top-shot"];

export function getTrackedCollections(): string[] {
  if (typeof window === "undefined") return DEFAULT_COLLECTIONS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_COLLECTIONS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_COLLECTIONS;
  } catch {
    return DEFAULT_COLLECTIONS;
  }
}

export function setTrackedCollections(ids: string[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {}
}

export function addTrackedCollection(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const current = getTrackedCollections();
    if (!current.includes(id)) {
      current.push(id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    }
  } catch {}
}

export function removeTrackedCollection(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const current = getTrackedCollections().filter(c => c !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {}
}
