"use client"

// lib/use-rookie-class-param.ts — the `?class=` a rookie board's PAGE URL names,
// read as an external store (2026-10-23). The URL is not React state: on the
// server and at hydration it is unknown (null → the default class), and the
// client snapshot takes over after hydration without a mismatch — the same
// shape as components/hub/LastCollectionShortcut.tsx reads localStorage.
// Not `useSearchParams()` (it demands a Suspense boundary to keep the ISR
// shell static) and not setState-in-an-effect (the hooks ratchet bans it).

import { useSyncExternalStore } from "react"
import { readRookieClassParam } from "@/lib/rookie-class-link"

function subscribe(cb: () => void): () => void {
  window.addEventListener("popstate", cb)
  return () => window.removeEventListener("popstate", cb)
}

/** The class the URL asks for (a known one), else null; null on the server. */
export function useRookieClassParam(classes: readonly string[]): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readRookieClassParam(window.location.search, classes),
    () => null,
  )
}
