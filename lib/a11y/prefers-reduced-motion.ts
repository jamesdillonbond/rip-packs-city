// `prefers-reduced-motion: reduce`, read without a set-state-in-effect: a
// useSyncExternalStore subscription to the media query. The server snapshot is
// `false`, so SSR and the first client paint agree; the real value lands on
// hydration's first subscription tick.
//
// 2026-11-07: the moment/edition hero (components/MomentHeroMedia) autoplayed a
// looping clip on mount with no motion guard — the only auto-starting video in
// the app that was not hover-mounted. Hover-mounted clips are user intent and
// stay as they are.
"use client"

import { useSyncExternalStore } from "react"

const QUERY = "(prefers-reduced-motion: reduce)"

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  const mq = window.matchMedia(QUERY)
  mq.addEventListener?.("change", onChange)
  return () => mq.removeEventListener?.("change", onChange)
}
function getSnapshot(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(QUERY).matches
}
const getServerSnapshot = () => false

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
