// Test-only ambient shim for the Cloudflare Workers runtime globals that the
// app tsconfig doesn't pull in (@cloudflare/workers-types is a wrangler-build
// concern, not an app dependency). The worker source files under workers/** are
// `exclude`d from the app tsconfig, but a worker-handler test that imports a
// worker's index.ts (e.g. worker-rpc-mcp-handler.test.ts) drags that source
// into the type-checked program, where its `satisfies ExportedHandler<Env>`
// annotation would otherwise TS2304. Declaring the type here (a global, so it's
// visible to the imported source) resolves it with ZERO runtime effect and
// without editing any worker source. ExecutionContext already resolves in the
// program, so it is deliberately NOT re-declared here (that would duplicate).

declare global {
  type ExportedHandler<Env = unknown> = {
    fetch?(request: Request, env: Env, ctx: any): Response | Promise<Response>
    scheduled?(event: any, env: Env, ctx: any): void | Promise<void>
  }
}

export {}
