import { defineConfig } from "vitest/config";

/**
 * Unit tests only. `e2e/**` is Playwright's tree — same `*.spec.ts` glob,
 * different runner, and Vitest picking it up too collides on `test.describe`.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
