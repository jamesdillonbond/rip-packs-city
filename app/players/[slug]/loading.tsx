import LoadingState from "@/components/ui/LoadingState"

// Route-level loading UI — shown while the server component awaits its data
// RPC, so navigation doesn't block on a blank screen.
export default function Loading() {
  return <LoadingState />
}
