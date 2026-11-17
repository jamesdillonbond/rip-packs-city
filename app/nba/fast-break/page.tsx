// app/nba/fast-break/page.tsx
//
// Server shell. The optimizer lives in FastBreakClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.

import FastBreakClient from "./FastBreakClient";

export default function FastBreakPage() {
  return <FastBreakClient />;
}
