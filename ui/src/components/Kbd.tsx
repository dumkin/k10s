import { Show } from "solid-js";
import { keyLabel } from "../lib/hotkeys";
import type { KeyId } from "../lib/keymap";

/** The key of a command of the keymap (`logs.wrap`), as a key cap: the one the settings give it now, if any. */
export function Kbd(props: { id: KeyId }) {
  return <Show when={keyLabel(props.id)}>{(label) => <span class="kbd">{label()}</span>}</Show>;
}
