import FmvHealthClient from "./FmvHealthClient"

// Server wrapper. The interactive body lives in FmvHealthClient.tsx so the component
// coverage gate measures it — a `page.tsx` is measured by NEITHER gate.
//
// This page reads no search params, so no Suspense boundary is required.
export default function FmvHealthPage() {
  return <FmvHealthClient />
}
