import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Scope to the lib/ layer — the pure, unit-testable logic. app/ routes,
      // components, and edge functions need integration tests, not this signal;
      // including them would drown the report in expected-0% noise. This number
      // is meant to grow as `lib/` coverage is filled in.
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/*.test.ts", "lib/**/*.d.ts"],
    },
  },
})
