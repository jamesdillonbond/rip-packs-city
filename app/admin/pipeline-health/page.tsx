import PipelineHealthClient from "./PipelineHealthClient"

// Server wrapper. The interactive body lives in PipelineHealthClient.tsx so the component
// coverage gate measures it — `vitest.components.config.ts` includes `app/**/*Client.tsx`,
// and a `page.tsx` is measured by NEITHER gate.
//
// This page reads no search params, so no Suspense boundary is required.
export default function PipelineHealthPage() {
  return <PipelineHealthClient />
}
