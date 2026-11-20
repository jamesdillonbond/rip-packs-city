"use client"

import { useEffect } from "react"

/**
 * Re-applies the saved LIGHT theme after mount.
 *
 * The root layout's pre-paint script sets `data-theme="light"` on <html> from localStorage.
 * On a not-found render that attribute did not survive: production read `class="dark …"` with
 * no `data-theme` on a 404 while every 200 page carried it (2026-11-19, light-contrast sweep —
 * a light-theme visitor got a dark 404). This puts it back from the same stored preference and
 * never removes it, so it cannot fight the toggle.
 */
export default function ThemeReassert() {
  useEffect(() => {
    try {
      if (localStorage.getItem("rpc_theme") === "light" && document.documentElement.dataset.theme !== "light") {
        document.documentElement.dataset.theme = "light"
      }
    } catch {
      // storage unavailable: the default (dark) stands
    }
  }, [])
  return null
}
