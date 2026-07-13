import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The orchestrator/db use module singletons; run test files sequentially in
    // one process so per-test temp DBs don't collide across worker threads.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts"],
    },
  },
});
