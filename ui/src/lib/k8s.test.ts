import { describe, expect, it } from "vitest";
import type { FeedStatus } from "./backend";
import { errorTitle, isAuthFailure, isAuthFailureMessage } from "./k8s";

const error = (message: string, code?: number, reason?: string) => ({ state: "error", message, code, reason }) as Extract<FeedStatus, { state: "error" }>;

describe("isAuthFailure", () => {
  it("tells failed credentials, which fresh ones fix, from other failures", () => {
    const auth = [
      error("Unauthorized: credentials are missing or expired (Unauthorized)", 401, "Unauthorized"),
      error("auth error: exec auth plugin `kubelogin get-token` failed (exit status: 1): please sign in again (run the plugin in a terminal to see why)"),
      error('cluster "prod-eu-z1": auth plugin `kubelogin` did not finish within 90s (waiting for a login?). Run it in a terminal to see why, then reconnect'),
      error('cluster "prod-eu-z1": auth plugin `kubelogin` was not found: install it or add its folder to PATH in your shell profile, then reconnect'),
    ];
    for (const st of auth) expect(isAuthFailure(st), st.message).toBe(true);
    const other = [
      error('pods is forbidden: User "jane" cannot list resource "pods" in API group "" at the cluster scope', 403, "Forbidden"),
      error('cluster "legacy-onprem": dial tcp 10.200.0.12:6443: i/o timeout (is the cluster reachable?)'),
      // Network trouble is the likelier reason here: trying again is the next step.
      error("no response from the API server within 60s (network trouble, or an auth plugin waiting for a login)"),
    ];
    for (const st of other) expect(isAuthFailure(st), st.message).toBe(false);
    expect(isAuthFailure({ state: "ready" })).toBe(false);
  });

  it("works on a connection's message alone", () => {
    expect(isAuthFailureMessage('cluster "prod-eu-z1": Unauthorized: credentials are missing or expired (Unauthorized)')).toBe(true);
    expect(isAuthFailureMessage('cluster "legacy-onprem": no answer within 60s (is the cluster reachable? VPN?)')).toBe(false);
    expect(isAuthFailureMessage(undefined)).toBe(false);
  });
});

describe("errorTitle", () => {
  it("names what went wrong", () => {
    expect(errorTitle(error("forbidden", 403, "Forbidden"))).toBe("No access");
    expect(errorTitle(error("Unauthorized: credentials are missing or expired (Unauthorized)", 401))).toBe("Not authorized — credentials expired?");
    expect(errorTitle(error("auth error: exec auth plugin `kubelogin get-token` failed (exit status: 1)"))).toBe("Sign-in failed");
    expect(errorTitle(error('resource "widgets.example.com" is not served by cluster "prod-eu-z1"', undefined, "NotFound"))).toBe("Not available");
    expect(errorTitle(error("dial tcp 10.200.0.12:6443: i/o timeout"))).toBe("Error");
  });
});
