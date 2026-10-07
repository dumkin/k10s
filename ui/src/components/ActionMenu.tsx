import { Index, Show } from "solid-js";
import { comboLabel } from "../lib/hotkeys";
import { type ActionContext, actionLabel, type ResourceAction } from "../registry/actions";
import { Icon } from "./Icon";

/**
 * Actions as items of a menu (the table's context menu, the details' "More"): destructive ones after a separator,
 * the ones read-only mode or missing permissions turn off greyed out — which of them where the key would be, the
 * tooltip says why. An item's key runs it while the menu is open (see `Popover`), on what the menu acts on.
 */
export function ActionMenuItems(props: { actions: ResourceAction[]; ctx: ActionContext; onRun: () => void }) {
  // By position, not by object: the actions are made anew whenever the cluster answers an access check, and the item
  // with the keyboard must stay the same element (a new one would drop the focus).
  return (
    <Index each={props.actions}>
      {(a, i) => (
        <>
          <Show when={a().danger && i > 0}>
            <div class="menu-sep" role="separator" />
          </Show>
          <button
            class="opt"
            role="menuitem"
            classList={{ danger: !!a().danger, locked: !!a().disabled, rbac: a().lock === "rbac" }}
            aria-disabled={a().disabled ? "true" : undefined}
            title={a().disabled ? a().disabledReason : a().note}
            data-key={a().disabled ? undefined : a().shortcut}
            onClick={() => {
              const action = a();
              if (action.disabled) return;
              props.onRun();
              void action.run(props.ctx);
            }}
          >
            <Icon name={a().icon} size={14} />
            <span>{actionLabel(a(), props.ctx)}</span>
            <Show when={a().disabled}>
              <span class="ro-tag">{a().lock === "rbac" ? "no access" : "read-only"}</span>
            </Show>
            <Show when={a().shortcut && !a().disabled}>
              <span class="kbd">{comboLabel(a().shortcut!)}</span>
            </Show>
          </button>
        </>
      )}
    </Index>
  );
}
