/** macOS (and iPadOS): ⌘ is the shortcut modifier there, and ⌃ a key of its own. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
