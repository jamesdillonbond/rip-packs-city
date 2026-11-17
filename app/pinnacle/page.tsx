import { redirect } from "next/navigation"

// Orphan Flowty-era standalone "Pin Sniper" page. Flowty shut down 2026-05-13
// and nothing links here anymore; the live Pinnacle surface is the dynamic
// /disney-pinnacle/* route. Redirect rather than serve the dead PinnacleSniper.
// (app/pinnacle/moment/[id]/ — the live per-pin pages — is a separate route
// and is intentionally left intact.)
export default function PinnaclePage() {
  redirect("/disney-pinnacle/overview")
}
