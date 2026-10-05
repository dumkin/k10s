import type { FeedStatus } from "./backend";

/** Namespace names are DNS-1123 labels: lowercase, so "Payments " becomes "payments". */
export function normalizeNamespace(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidNamespace(ns: string): boolean {
  return ns.length > 0 && ns.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(ns);
}

type ErrorStatus = Extract<FeedStatus, { state: "error" }>;

export function isError(st: FeedStatus | undefined): st is ErrorStatus {
  return st?.state === "error";
}

export function isForbidden(st: FeedStatus | undefined): boolean {
  return isError(st) && (st.code === 403 || st.reason === "Forbidden");
}

export function isUnauthorized(st: FeedStatus | undefined): boolean {
  return isError(st) && (st.code === 401 || st.reason === "Unauthorized");
}

/** How the engine words credentials it could not get (an auth plugin that failed, is missing or waits for a login) or that expired. */
const AUTH_FAILURE = /auth plugin `|credentials are missing or expired/i;

/** `isAuthFailure` for an error of which only the message is known (a failed connection). */
export const isAuthFailureMessage = (message: string | null | undefined) => !!message && AUTH_FAILURE.test(message);

/**
 * The credentials were rejected (401) or could not be had (the exec auth plugin failed): fresh ones are the next
 * step — a reconnect, which runs the plugin again — not trying again with the same ones.
 */
export function isAuthFailure(st: FeedStatus | undefined): boolean {
  return isError(st) && (isUnauthorized(st) || isAuthFailureMessage(st.message));
}

/** Short human title for an error status ("No access", "Not signed in"…). */
export function errorTitle(st: ErrorStatus): string {
  if (isForbidden(st)) return "No access";
  if (isUnauthorized(st)) return "Not authorized — credentials expired?";
  if (isAuthFailure(st)) return "Sign-in failed";
  if (st.code === 404 || st.reason === "NotFound") return "Not available";
  return "Error";
}
