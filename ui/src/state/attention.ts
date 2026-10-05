import { createSignal } from "solid-js";
import type { Severity } from "../lib/attention";

/** Critical issues and warnings the "Needs attention" view shows right now (the sidebar's count); null while it is closed. */
export const [attentionCount, setAttentionCount] = createSignal<number | null>(null);

// The view's own state, kept while the app runs: opening an object and coming back (⌘[) finds it as it was left.
export const [attentionFilter, setAttentionFilter] = createSignal("");
export const [attentionCluster, setAttentionCluster] = createSignal<string | null>(null);
export const [attentionSeverity, setAttentionSeverity] = createSignal<Severity | null>(null);
export const [attentionSelected, setAttentionSelected] = createSignal<string | null>(null);
export const [attentionExpanded, setAttentionExpanded] = createSignal<ReadonlySet<string>>(new Set());
/** Where the list was scrolled to. */
export const attentionScroll = { top: 0 };
/** When each object was first seen like this (what rows do not say: how long something has been terminating). */
export const attentionSeen = { map: new Map<string, number>() };
