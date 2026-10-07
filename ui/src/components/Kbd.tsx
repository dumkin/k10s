import { Show } from "solid-js";
import { keyLabel } from "../lib/hotkeys";

/** The key of a command of the keymap (`logs.wrap`), as a key cap: the one the settings give it now, if any. */
export function Kbd(props: { id: string }) {
  return <Show when={keyLabel(props.id)}>{(label) => <span class="kbd">{label()}</span>}</Show>;
}
