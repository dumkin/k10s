import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => vi.restoreAllMocks());

const load = () => import("./recent");
const fresh = async (limit = 3) => (await load()).recentList("recentTest", limit);

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

  it("does not take back what was forgotten after it was chosen, but takes it chosen again", async () => {
    const { moment } = await load();
    const recent = await fresh();
    const typed = moment();
    recent.remember("payments", typed);
    recent.forget("payments");
    recent.remember("payments", typed);
    expect(recent.list()).toEqual([]);
    recent.remember("payments", moment());
    expect(recent.list()).toEqual(["payments"]);
    // Forget all: the same, for every entry.
    const before = moment();
    recent.clear();
    recent.remember("orders", before);
    expect(recent.list()).toEqual([]);
  });
});

describe("a field's use", () => {
  it("remembers on use; a text dropped only once it stood a while and showed something", async () => {
    const { KEPT_MS, recentUse } = await load();
    const recent = await fresh();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const use = recentUse(recent);
    use.changed();
    use.dropped("pdo-1", true);
    now += KEPT_MS;
    use.dropped("pdo-1", false);
    expect(recent.list()).toEqual([]);
    use.dropped("pod-1", true);
    use.changed();
    use.used("pod-2");
    expect(recent.list()).toEqual(["pod-2", "pod-1"]);
  });

  it("does not bring back what another field forgot while this one holds it, nor what history puts back", async () => {
    const { KEPT_MS, recentUse } = await load();
    const recent = await fresh();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // Two log views: the same query in both, forgotten from one of them.
    const a = recentUse(recent);
    const b = recentUse(recent);
    a.changed();
    b.changed();
    a.used("timeout");
    recent.forget("timeout");
    b.used("timeout");
    now += KEPT_MS;
    b.dropped("timeout", true);
    expect(recent.list()).toEqual([]);
    // Put back from history: chosen before it was forgotten.
    a.restored();
    a.used("timeout");
    expect(recent.list()).toEqual([]);
    // History putting back one that was not forgotten: it is used again once it stood.
    recent.remember("orders");
    recent.remember("payments");
    a.restored();
    now += KEPT_MS;
    a.dropped("orders", true);
    expect(recent.list()).toEqual(["orders", "payments"]);
  });
});
