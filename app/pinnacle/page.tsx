import { redirect } from "next/navigation"

// Orphan Flowty-era standalone "Pin Sniper" page. Flowty shut down 2026-05-13
// and nothing links here anymore; the live Pinnacle surface is the dynamic
// /disney-pinnacle/* route. Redirect rather than serve the dead PinnacleSniper.
// (app/pinnacle/moment/[id]/ is a separate route and is intentionally left
// intact — since 2026-09-20 it is a PERMANENT REDIRECT to the per-pin page's
// new home at /disney-pinnacle/edition/<render_id>, holding its indexed URLs
// open. Do not delete it.)
export default function PinnaclePage() {
  redirect("/disney-pinnacle/overview")
}
