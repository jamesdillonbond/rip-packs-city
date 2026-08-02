export function safeLoadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function safeSaveJson<T>(key: string, value: T) {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore storage failures
  }
}

export function safeLoadString(key: string, fallback = ""): string {
  if (typeof window === "undefined") return fallback

  try {
    return window.localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

export function safeSaveString(key: string, value: string) {
  if (typeof window === "undefined") return

  try {
    window.localStorage.setItem(key, value)
  } catch {
    // ignore storage failures
  }
}