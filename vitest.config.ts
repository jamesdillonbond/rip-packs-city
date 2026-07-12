import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts", "__tests__/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Two tested layers are measured here: the pure lib/ logic (unit tests)
      // and the app/api route handlers (integration tests). Every route is
      // imported and its auth/param guards are exercised; a growing subset also
      // drive the 2xx success/accept path (ingest indexers, fmv-recalc, …) by
      // stubbing the after()/Supabase seam — but many routes remain guard-depth
      // only, so a high line % here does NOT imply the happy-path business logic
      // is covered. The Deno edge functions (supabase/functions) and React
      // components are NOT measured: their pure logic is being extracted into
      // vitest-importable modules (see supabase/functions/_shared, lib/*), and
      // until a component/edge harness exists they're excluded so the number
      // reflects what the suite actually drives, not expected-0% noise.
      include: ["lib/**/*.ts", "app/api/**/route.ts"],
      exclude: ["lib/**/*.test.ts", "lib/**/*.d.ts"],
    },
  },
})
