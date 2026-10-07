import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const fresh = async (limit = 3) => (await import("./recent")).recentList("recentTest", limit);

describe("recent list", () => {
  it("keeps what was used, the most recent first, each once, as many as it may", async () => {
    const recent = await fresh();
    for (const s of ["app=web", "payments", "app=web", "  orders  ", "redis"]) recent.remember(s);
    expect(recent.list()).toEqual(["redis", "orders", "app=web"]);
  });

  it("does not keep a single character or blanks", async () => {
    const recent = await fresh();
    recent.remember("a");
    recent.remember("   ");
    expect(recent.list()).toEqual([]);
  });

  it("forgets one, or all of them", async () => {
    const recent = await fresh();
    recent.remember("app=web");
    recent.remember("payments");
    recent.forget("app=web");
    recent.forget("never used");
    expect(recent.list()).toEqual(["payments"]);
    recent.clear();
    expect(recent.list()).toEqual([]);
  });

  it("is there again at the next start", async () => {
    (await fresh()).remember("payments");
    vi.resetModules();
    expect((await fresh()).list()).toEqual(["payments"]);
  });
});
