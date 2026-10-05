import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

// UI tests run the real Solid components in jsdom (browser build of solid-js, not the SSR one).
export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: { conditions: ["development", "browser"] },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
    },
  }),
);
