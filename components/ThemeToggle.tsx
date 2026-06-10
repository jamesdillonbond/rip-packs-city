"use client"

import { useEffect, useState } from "react"

// Optional LIGHT-mode toggle. DARK is the product default — a fresh visitor
// gets no `data-theme` attribute and renders dark exactly as before. The
// pre-paint boot script in app/layout.tsx sets data-theme="light" before
// hydration when the user has opted in, so this component only has to read the
// already-applied state on mount and flip it on click.
//
// Persisted in localStorage under 'rpc_theme' ('light' | 'dark'). OS
// prefers-color-scheme is deliberately NOT consulted — dark is the brand
// default regardless of OS.
export default function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark")

  // Server render + first client render both default to "dark" (matching the
  // no-attribute default), so there is no hydration mismatch. This corrects to
  // the real applied theme after mount.
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark")
  }, [])

  function toggle() {
    const next = theme === "light" ? "dark" : "light"
    setTheme(next)
    try {
      if (next === "light") {
        document.documentElement.dataset.theme = "light"
        localStorage.setItem("rpc_theme", "light")
      } else {
        delete document.documentElement.dataset.theme
        localStorage.setItem("rpc_theme", "dark")
      }
    } catch {
      /* private mode / storage disabled — the attribute flip still applies */
    }
  }

  const isLight = theme === "light"

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
      title={isLight ? "Switch to dark mode" : "Switch to light mode"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 30,
        height: 30,
        flexShrink: 0,
        background: "transparent",
        border: "1px solid var(--rpc-border)",
        borderRadius: "var(--radius-sm)",
        color: "var(--rpc-text-secondary)",
        cursor: "pointer",
        transition: "color var(--transition-fast), border-color var(--transition-fast)",
      }}
    >
      {isLight ? (
        // Moon — currently light, click switches to dark
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        // Sun — currently dark, click switches to light
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      )}
    </button>
  )
}
