// lib/logger.ts — Structured JSON logger for Vercel runtime logs
// Usage: import { log } from "@/lib/logger"
//        log.info("sniper-feed", "fetched 42 listings", { source: "flowty" })
//        log.error("fmv-recalc", "computation failed", { editionKey: "84:2892" }, err)
//
// Outputs single-line JSON so Vercel log drain / search can parse fields.
// Uses console.log for all levels (console.warn is not indexed by Vercel).

type LogLevel = "info" | "warn" | "error"

interface LogEntry {
  level: LogLevel
  tag: string
  msg: string
  ts: string
  [key: string]: unknown
}

function emit(level: LogLevel, tag: string, msg: string, meta?: Record<string, unknown>, err?: unknown) {
  const entry: LogEntry = {
    level,
    tag,
    msg,
    ts: new Date().toISOString(),
    ...meta,
  }

  if (err instanceof Error) {
    entry.error = err.message
    entry.stack = err.stack
  } else if (err !== undefined) {
    entry.error = String(err)
  }

  // Always use console.log — Vercel does not index console.warn/console.error in log search
  console.log(JSON.stringify(entry))
}

export const log = {
  info: (tag: string, msg: string, meta?: Record<string, unknown>) =>
    emit("info", tag, msg, meta),

  warn: (tag: string, msg: string, meta?: Record<string, unknown>) =>
    emit("warn", tag, msg, meta),

  error: (tag: string, msg: string, meta?: Record<string, unknown>, err?: unknown) =>
    emit("error", tag, msg, meta, err),
}
