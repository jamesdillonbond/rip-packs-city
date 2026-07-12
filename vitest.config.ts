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
      // Two tested layers: the pure lib/ logic (unit tests) and the app/api
      // route handlers (integration tests — all 443 routes are exercised, most
      // at guard/branch depth). Components + edge functions still need their
      // own harness and are excluded so the number reflects what the suite
      // actually drives, not expected-0% noise.
      include: ["lib/**/*.ts", "app/api/**/route.ts"],
      exclude: ["lib/**/*.test.ts", "lib/**/*.d.ts"],
    },
  },
})
