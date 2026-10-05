import { detailsFull } from "./nav";
import { dialog, helpOpen, paletteOpen, pickerOpen, popoverOpen, settingsOpen } from "./ui";

// Who has the keyboard. Single keys (j, /, g…) mean something else in the table and in the details panel; these
// decide which one they go to — and which keys the hints (⌘ held) show.

/** Something modal is open: the palette, a picker, a dialog, the shortcuts sheet, the settings, a menu. */
export const modalOpen = () => !!paletteOpen() || !!pickerOpen() || !!dialog() || helpOpen() || !!settingsOpen() || popoverOpen();

/** Keyboard focus is in the details panel (logs, YAML, their fields and buttons). */
export const focusInDetails = () => !!document.activeElement?.closest(".details");

/** Keyboard focus is in the dock (a terminal, its tabs). */
export const focusInDock = () => !!document.activeElement?.closest(".dock");

/** Keyboard focus is in the sidebar's list (Tab took it there): its keys move along the list. */
export const focusInSidebar = () => !!document.activeElement?.closest(".sidebar");

/** The details panel has the keyboard: it fills the window, or focus is in it. Its keys scroll and search it. */
export const detailsHaveKeyboard = () => !modalOpen() && (detailsFull() || focusInDetails());

/** The table has the keyboard: moving, marking, filtering and the action keys work on it. */
export const tableHasKeyboard = () => !modalOpen() && !detailsFull() && !focusInDetails() && !focusInDock() && !focusInSidebar();

/** The element a keystroke went to is a control of its own (a field, a button…): its keys are its own. */
export const onControl = (e: KeyboardEvent) => !!(e.target as Element | null)?.closest?.("input, textarea, select, button, a[href], [contenteditable]");
