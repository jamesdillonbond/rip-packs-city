// The answer a warm-cache consumer may show for the query it is asking NOW (2026-11-14).
//
// `useWarmCache` keeps the previous key's `data` while a new key loads — and after that load
// fails — and reports the key it belongs to as `dataKey`. A consumer rendering `data` directly
// shows the previous filter's rows under the new filter (the Packs board did). This returns the
// data only when it answers `key`; otherwise null, so the consumer shows loading / error instead.
export function answerFor<T>(data: T | null | undefined, dataKey: string | null | undefined, key: string): T | null {
  return data != null && dataKey === key ? data : null
}
