// lib/a11y/scroll-region.ts
//
// Props for a horizontally scrollable container (`.rpc-scroll-x`) so a keyboard
// user can reach and scroll it, and a screen reader announces what it holds.
//
// WHY (2026-10-25): axe `scrollable-region-focusable` (WCAG 2.1.1, serious) on the
// live edition and player pages at phone width — a table wider than the screen
// inside a div nothing can focus is unreachable without a pointer. The W3C pattern
// for a scrollable area is a focusable, NAMED region; the name is per call site
// (what the region holds), never a generic "scrollable", so a screen reader user
// moving by landmark can tell two regions apart.
//
// Guard: __tests__/scroll-regions-are-keyboard-reachable.test.ts — every
// `className="rpc-scroll-x"` element spreads this.
export function scrollRegion(label: string): { tabIndex: 0; role: "region"; "aria-label": string } {
  return { tabIndex: 0, role: "region", "aria-label": label }
}
