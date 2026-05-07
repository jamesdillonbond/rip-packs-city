"use client";

import { useEffect } from "react";

let greeted = false;

export default function ConsoleGreeting() {
  useEffect(() => {
    if (greeted) return;
    greeted = true;
    try {
      // The literal "#E03A2F" is the only sanctioned hardcode of the brand red:
      // CSS custom properties (var(--rpc-red)) are not readable inside DevTools
      // console %c styling, so the value must be inlined here.
      console.log(
        "%cRip City! All right!%c\nBuilt in Rip City. Welcome to Rip Packs City.",
        "color:#E03A2F;font-size:24px;font-weight:700;letter-spacing:0.04em;",
        "color:#888;font-size:12px;font-weight:400;",
      );
    } catch {
      // console unavailable — never throw from a greeting.
    }
  }, []);

  return null;
}
