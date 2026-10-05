import { describe, expect, it } from "vitest";
import { Tone } from "../lib/backend";
import { compileFilter } from "./table";
import type { UIRow } from "./view";

const row = (n: string, labels: string, cells: UIRow["c"] = []): UIRow => ({ key: `z1/${n}`, cl: "prod-eu-z1", u: n, n, ns: "payments", rv: "1", t: 0, s: Tone.Ok, c: cells, l: labels });

const web = row("web-7d9", "app=web tier=frontend");
const canary = row("web-canary-5c1", "app=web-canary tier=frontend");
const k8sApp = row("dns-1", "k8s-app=web");
const hook = row("webhook-0", "app=webhook");
// A Deployment whose own labels differ but whose (hidden) selector column says app=web.
const selector = row("router", "app=router", ["app=web"]);
const unlabelled = row("job-1", "");
const all = [web, canary, k8sApp, hook, selector, unlabelled];
const names = (q: string) => all.filter(compileFilter(q) ?? (() => true)).map((r) => r.n);

describe("compileFilter", () => {
  it("matches key=value terms against labels exactly, like kubectl -l", () => {
    expect(names("app=web")).toEqual(["web-7d9"]);
    expect(names("app==web")).toEqual(["web-7d9"]);
    expect(names("tier=frontend")).toEqual(["web-7d9", "web-canary-5c1"]);
    expect(names("app=web tier=frontend")).toEqual(["web-7d9"]);
    expect(names("App=web")).toEqual([]);
  });

  it("matches key!=value when the label is missing or different", () => {
    expect(names("app!=web")).toEqual(["web-canary-5c1", "dns-1", "webhook-0", "router", "job-1"]);
    expect(names("!app=web")).toEqual(names("app!=web"));
    expect(names("tier=frontend app!=web")).toEqual(["web-canary-5c1"]);
  });

  it("takes comma-joined selectors like kubectl -l: all labels must match", () => {
    expect(names("app=web,tier=frontend")).toEqual(["web-7d9"]);
    expect(names("tier=frontend,app!=web")).toEqual(["web-canary-5c1"]);
    expect(names("app=web,tier=backend")).toEqual([]);
    // Negated: not all of them.
    expect(names("!app=web,tier=frontend")).toEqual(["web-canary-5c1", "dns-1", "webhook-0", "router", "job-1"]);
    // A trailing comma is the next part being typed; a part that is no label makes it plain text.
    expect(names("app=web,")).toEqual(["web-7d9"]);
    expect(names("app=web,frontend")).toEqual([]);
    expect(names('"app=web,tier=frontend"')).toEqual([]);
    expect(names(",")).toEqual([]);
  });

  it("keeps substring search for other terms", () => {
    expect(names("web")).toEqual(["web-7d9", "web-canary-5c1", "dns-1", "webhook-0", "router"]);
    expect(names("WEB !canary")).toEqual(["web-7d9", "dns-1", "webhook-0", "router"]);
    // Quoted: plain text search, labels and cells included.
    expect(names('"app=web"')).toEqual(["web-7d9", "web-canary-5c1", "dns-1", "webhook-0", "router"]);
    expect(names("!")).toEqual(names(""));
    expect(compileFilter("   ")).toBeNull();
  });

  it("handles labels with prefixes and empty values", () => {
    const r = row("x", "app.kubernetes.io/name=api team= release=v1.2_3");
    expect(compileFilter("app.kubernetes.io/name=api")!(r)).toBe(true);
    expect(compileFilter("team=")!(r)).toBe(true);
    expect(compileFilter("release=v1.2_3")!(r)).toBe(true);
    expect(compileFilter("release=v1.2")!(r)).toBe(false);
  });
});
