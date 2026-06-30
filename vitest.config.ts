import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "evals/**/*.test.mjs", "evals/**/*.test.ts"],
  },
});
