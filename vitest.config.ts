import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: { runtime: "automatic" }
  },
  resolve: {
    alias: [
      {
        find: /^@council\/database\/seed$/,
        replacement: fileURLToPath(new URL("./packages/database/src/seed.ts", import.meta.url))
      },
      {
        find: /^@council\/contracts$/,
        replacement: fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url))
      },
      {
        find: /^@council\/domain$/,
        replacement: fileURLToPath(new URL("./packages/domain/src/index.ts", import.meta.url))
      },
      {
        find: /^@council\/database$/,
        replacement: fileURLToPath(new URL("./packages/database/src/index.ts", import.meta.url))
      },
      {
        find: /^@council\/runtime$/,
        replacement: fileURLToPath(new URL("./packages/runtime/src/index.ts", import.meta.url))
      }
    ]
  },
  test: {
    include: ["packages/**/*.test.{ts,tsx}", "apps/**/*.test.{ts,tsx}", "scripts/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"]
    }
  }
});
