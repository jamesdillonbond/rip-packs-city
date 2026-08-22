"use client";

import { useEffect } from "react";

let greeted = false;

export default function ConsoleGreeting() {
  useEffect(() => {
    if (greeted) return;
    greeted = true;
    try {
      // ⚠ This used to claim it was "the only sanctioned hardcode of the brand
      // red". That was STALE and the deep audit caught it: the recharts SVG
      // strokes in FmvHistoryChart and PinnacleFmvChart are sanctioned too (SVG
      // props cannot resolve var() either), as is the separate email accent,
      // hardcoded on purpose because email clients lack custom properties.
      // A uniqueness claim in a comment has no guard behind it and rots quietly —
      // state the REASON, which stays true, not the COUNT, which does not.
      //
      // brand-exception: CSS custom properties (var(--rpc-red)) are not readable
      // inside DevTools console %c styling, so the value must be inlined here.
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
