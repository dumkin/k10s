import { vi } from "vitest";

// vite-plugin-solid inlines Solid for DOM tests. Keep its real runtime alive across
// resetModules so cached mocks and fresh app modules share the same reactive graph.
vi.mock("solid-js", async (importOriginal) => importOriginal<typeof import("solid-js")>());
