"use client"

import { useEffect, useState } from "react"

// Tracks whether the viewport is < 768px. Defaults to true (mobile-first) until
// the first client measurement. Extracted verbatim in the Phase 1 refactor.
export function useMobile() {
  const [isMobile, setIsMobile] = useState(true)
  useEffect(function() {
    setIsMobile(window.innerWidth < 768)
    function onResize() { setIsMobile(window.innerWidth < 768) }
    window.addEventListener("resize", onResize)
    return function() { window.removeEventListener("resize", onResize) }
  }, [])
  return isMobile
}
