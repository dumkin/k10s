import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { bind, bindAll, comboLabel } from "../lib/hotkeys";
import { holdInert } from "../lib/inert";
import { focusInSidebar, modalOpen } from "../state/keyboard";
import { type DialogRequest, dialog, dismissToast, pauseToast, resumeToast, setDialog, type Toast, toasts } from "../state/ui";
import { Icon } from "./Icon";

/** How long a dismissed toast takes to fade out (its `toast-out` animation). */
export const TOAST_LEAVE_MS = 160;

export function Toasts() {
  // What is on screen: the toasts, and for a moment each one just gone, where it was, fading out — a toast never
  // just vanishes, and the ones below it slide up only once it has.
  const [shown, setShown] = createSignal<Toast[]>([]);
  const [leaving, setLeaving] = createSignal<ReadonlySet<number>>(new Set());
  createEffect(
    on(toasts, (now) => {
      const ids = new Set(now.map((t) => t.id));
      const prev = shown();
      const gone = prev.filter((t) => !ids.has(t.id) && !leaving().has(t.id));
      const known = new Set(prev.map((t) => t.id));
      setShown([...prev.filter((t) => ids.has(t.id) || leaving().has(t.id) || gone.includes(t)), ...now.filter((t) => !known.has(t.id))]);
      if (!gone.length) return;
      setLeaving((l) => new Set([...l, ...gone.map((t) => t.id)]));
      setTimeout(() => {
        const out = new Set(gone.map((t) => t.id));
        setShown((list) => list.filter((t) => !out.has(t.id)));
        setLeaving((l) => new Set([...l].filter((id) => !out.has(id))));
      }, TOAST_LEAVE_MS);
    }),
  );
  // Esc, when nothing else takes it (a field, the details, marks, the filter…): the newest toast goes.
  onMount(() =>
    onCleanup(
      bind({
        combo: "escape",
        priority: -10,
        when: () => !modalOpen() && !focusInSidebar(),
        run: () => {
          const list = toasts();
          let i = list.length - 1;
          while (i >= 0 && list[i].kind === "busy") i--;
          if (i < 0) return false;
          dismissToast(list[i].id);
        },
      }),
    ),
  );
  return (
    <Portal>
      <div class="toasts">
        <For each={shown()}>
          {(t) => {
            const [copied, setCopied] = createSignal(false);
            const copy = async () => {
              try {
                await navigator.clipboard.writeText(t.copy ?? "");
                setCopied(true);
              } catch {
                // no clipboard access: the text stays selectable
              }
            };
            // Closed by its button, not by a click on the text: that has to stay selectable. Hovering keeps it on screen.
            return (
              <div
                class={`toast ${t.kind}`}
                classList={{ leaving: leaving().has(t.id) }}
                role={t.kind === "error" ? "alert" : "status"}
                onMouseEnter={() => pauseToast(t.id)}
                onMouseLeave={() => resumeToast(t.id)}
              >
                <Show when={t.kind !== "busy"} fallback={<span class="spinner" style={{ width: "14px", height: "14px", margin: "1px" }} />}>
                  <Icon name={t.kind === "error" ? "alert-circle" : t.kind === "success" ? "check" : "info"} size={16} />
                </Show>
                <div style={{ "min-width": 0, flex: "1 1 auto" }}>
                  <div class="t-title">{t.title}</div>
                  <Show when={t.detail}>
                    <div class="t-detail" style={{ "white-space": "pre-line", "max-height": "40vh", overflow: "auto" }}>
                      {t.detail}
                    </div>
                  </Show>
                  <Show when={t.copy}>
                    <button class="btn sm ghost" style={{ "margin-top": "6px", "margin-left": "-7px" }} onClick={() => void copy()} title="Every target with its cluster, namespace and error">
                      <Icon name={copied() ? "check" : "copy"} size={12} />
                      {copied() ? "Copied" : "Copy details"}
                    </button>
                  </Show>
                </div>
                <button class="btn sm ghost icon" style={{ flex: "none", "margin-top": "-2px" }} title="Dismiss (Esc)" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            );
          }}
        </For>
      </div>
    </Portal>
  );
}

/** Items listed in a dialog: more are summarised (a dialog over ⌘A on 50,000 rows must still open at once). */
export const DIALOG_MAX_ITEMS = 200;

/**
 * Confirmations are ignored this long after a dialog opens: the key press that opened it (or a confirmation
 * one step earlier in a chain, like "Scale to 0?") must not also confirm it, nor the second click of a
 * double-click on the menu item or palette row that opened it, landing on its button.
 */
export const DIALOG_ARM_MS = 350;

export function Dialog() {
  // Keyed: each request gets its own DialogBox holding a plain value. A non-keyed <Show> accessor
  // throws ("stale read") once `finish` has closed the dialog and then reads the request again.
  return (
    <Show when={dialog()} keyed>
      {(d) => <DialogBox req={d} />}
    </Show>
  );
}

function DialogBox(props: { req: DialogRequest }) {
  const req = props.req;
  const openedAt = performance.now();
  const armed = () => performance.now() - openedAt >= DIALOG_ARM_MS;
  const [input, setInput] = createSignal(req.input?.value ?? "");
  const [checked, setChecked] = createSignal(req.checkbox?.value ?? false);
  const [typed, setTyped] = createSignal("");
  const [fields, setFields] = createSignal((req.fields ?? []).map((f) => f.value));
  const [choice, setChoice] = createSignal(req.choice?.value);
  /** Why confirming is blocked (shown unless ""), or null. */
  const invalid = createMemo(() => {
    if (req.input && req.validate) return req.validate(input());
    for (const [i, f] of (req.fields ?? []).entries()) {
      const v = fields()[i].trim();
      if (!v && !f.optional) return "";
      const why = v ? f.validate?.(v) : null;
      if (why != null) return why;
    }
    return null;
  });
  /** What has to be typed to confirm, now (ticking "Force" can ask for it). */
  const required = createMemo(() => (typeof req.confirmText === "function" ? req.confirmText(checked()) : req.confirmText));
  const blocked = () => invalid() !== null || (!!required() && typed().trim() !== required());
  let box: HTMLDivElement | undefined;
  let cancelBtn: HTMLButtonElement | undefined;
  let inputEl: HTMLInputElement | undefined;
  let confirmEl: HTMLInputElement | undefined;
  let firstField: HTMLInputElement | undefined;
  let checkedChoice: HTMLInputElement | undefined;
  const finish = (ok: boolean) => {
    if (ok && blocked()) return;
    setDialog(null);
    // Fields and the choice only when asked for: what callers get stays what they asked.
    const extra = { ...(req.fields ? { fields: fields().map((f) => f.trim()) } : {}), ...(req.choice ? { choice: choice() } : {}) };
    req.resolve(ok ? { input: input(), checkbox: checked(), ...extra } : null);
  };
  /** ⌘↵, Enter in the input: never from auto-repeat, never right after opening. */
  const confirmByKey = (e: KeyboardEvent) => {
    if (!e.repeat && armed()) finish(true);
  };
  // The typed confirmation appears (Force ticked): type there next. It disappears with focus in it: back to Cancel.
  createEffect(
    on(
      required,
      (now) => {
        if (now) queueMicrotask(() => confirmEl?.focus());
        else if (!document.activeElement || document.activeElement === document.body) cancelBtn?.focus();
      },
      { defer: true },
    ),
  );
  /** Tab and ⇧Tab go round the dialog's own controls (also where macOS would skip buttons). */
  const cycle = (step: 1 | -1) => {
    // A group of radio buttons is one stop (its checked one), as browsers have it.
    const controls = [...(box?.querySelectorAll<HTMLElement>("input:not([disabled]):not([type=radio]), input[type=radio]:checked, button:not([disabled])") ?? [])];
    if (!controls.length) return false;
    const at = controls.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (step > 0 ? 0 : controls.length - 1) : (at + step + controls.length) % controls.length;
    controls[next].focus();
  };
  onMount(() => {
    // Nothing behind the dialog takes focus, clicks or a screen reader's attention while it is open, and
    // focus goes back where it was when it closes (the logs, say: their keys must keep working).
    const back = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const release = holdInert();
    onCleanup(() => {
      release();
      // Unless whatever the dialog's outcome did took focus elsewhere on purpose.
      const at = document.activeElement;
      const lost = !at || at === document.body || !at.isConnected || !!box?.contains(at);
      if (lost && back?.isConnected) back.focus({ preventScroll: true });
    });
    // Confirmations open on Cancel: a stray Enter or Space (the row-marking key) must not confirm them.
    // A typed confirmation can't be confirmed by a stray key either, so it opens where the typing goes.
    // Fields and choices are what the dialog asks for (they confirm nothing by themselves): typing and picking start there.
    const field = inputEl ?? firstField;
    if (field) {
      field.focus();
      field.select();
    } else if (confirmEl) confirmEl.focus();
    else if (checkedChoice && !req.danger) checkedChoice.focus();
    else cancelBtn?.focus();
    // Key auto-repeat (Enter held in the palette, Space held while marking rows) must not reach the
    // dialog's buttons; a fresh press passes through.
    const swallowRepeat = (e: KeyboardEvent) => (e.repeat ? undefined : false);
    onCleanup(
      bindAll([
        { combo: "escape", inInputs: true, priority: 300, run: () => finish(false) },
        { combo: "mod+enter", inInputs: true, priority: 300, run: (e) => confirmByKey(e) },
        { combo: "enter", inInputs: true, priority: 300, run: swallowRepeat },
        { combo: "space", inInputs: true, priority: 300, run: swallowRepeat },
        { combo: "tab", inInputs: true, priority: 300, run: () => cycle(1) },
        { combo: "shift+tab", inInputs: true, priority: 300, run: () => cycle(-1) },
      ]),
    );
  });
  return (
    <Portal>
      <div class="overlay dim" onMouseDown={() => finish(false)} />
      <div ref={box} class="dialog" role="alertdialog" aria-modal="true" aria-label={req.title}>
        <div class="dlg-body">
          <h2>
            <Show when={req.danger}>
              <span class="dlg-icon" aria-hidden="true">
                <Icon name="alert" size={15} />
              </span>
            </Show>
            {req.title}
          </h2>
          <Show when={req.body}>
            <p>{req.body}</p>
          </Show>
          <Show when={req.breakdown?.length}>
            <div class="dlg-breakdown" style={{ display: "flex", "flex-wrap": "wrap", gap: "4px 12px", "font-size": "var(--fs-sm)", color: "var(--text-2)" }}>
              <span>{req.breakdown!.length > 1 ? `In ${req.breakdown!.length} clusters:` : "In"}</span>
              <For each={req.breakdown}>
                {(b) => (
                  <span style={{ display: "inline-flex", "align-items": "center", gap: "5px" }}>
                    <Show when={b.color}>
                      <span style={{ width: "7px", height: "7px", "border-radius": "50%", background: b.color }} />
                    </Show>
                    <span style={{ color: "var(--text)", "font-weight": 600 }}>{b.label}</span>
                    <span>{b.count === 1 ? "1 object" : `${b.count.toLocaleString("en-US")} objects`}</span>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <Show when={req.items?.length}>
            <div class="dlg-items">
              <For each={req.items!.slice(0, DIALOG_MAX_ITEMS)}>
                {(it) => (
                  <div>
                    <Show when={it.color}>
                      <span class="swatch" style={{ width: "7px", height: "7px", "border-radius": "50%", background: it.color }} />
                    </Show>
                    <span class="ellipsis">{it.label}</span>
                    <span class="meta">{it.meta}</span>
                  </div>
                )}
              </For>
              <Show when={req.items!.length > DIALOG_MAX_ITEMS}>
                <div class="faint">…and {(req.items!.length - DIALOG_MAX_ITEMS).toLocaleString("en-US")} more</div>
              </Show>
            </div>
          </Show>
          <Show when={req.input}>
            {(field) => (
              <>
                <input
                  ref={inputEl}
                  class="input"
                  type={field().type ?? "text"}
                  placeholder={field().placeholder}
                  value={input()}
                  aria-invalid={invalid() !== null}
                  onInput={(e) => setInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.isComposing) return;
                    // No keypress: it would activate whatever gets focus next (a chained dialog's button).
                    e.preventDefault();
                    confirmByKey(e);
                  }}
                />
                <Show when={invalid()}>
                  <div class="dlg-error">{invalid()}</div>
                </Show>
              </>
            )}
          </Show>
          <Show when={req.choice}>
            {(c) => (
              // Real radio buttons: arrows move between them, Tab leaves the group, Enter confirms.
              <div class="dlg-choice" role="radiogroup" aria-label={c().label}>
                <Show when={c().label}>
                  <span class="dlg-choice-label">{c().label}</span>
                </Show>
                <For each={c().options}>
                  {(o) => (
                    <label class="dlg-option" classList={{ on: choice() === o.value }}>
                      <input
                        ref={(el) => o.value === c().value && (checkedChoice = el)}
                        type="radio"
                        class="visually-hidden"
                        name="dlg-choice"
                        value={o.value}
                        checked={choice() === o.value}
                        onChange={() => setChoice(o.value)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" || e.isComposing) return;
                          e.preventDefault();
                          confirmByKey(e);
                        }}
                      />
                      <span class="radio" aria-hidden="true" />
                      <span class="ellipsis">{o.label}</span>
                      <Show when={o.meta}>
                        <span class="meta">{o.meta}</span>
                      </Show>
                    </label>
                  )}
                </For>
              </div>
            )}
          </Show>
          <For each={req.fields}>
            {(f, i) => (
              <label class="dlg-field">
                <span>{f.label}</span>
                <input
                  ref={(el) => i() === 0 && (firstField = el)}
                  class="input mono"
                  type="text"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck={false}
                  placeholder={f.placeholder}
                  value={fields()[i()]}
                  onInput={(e) => {
                    const v = e.currentTarget.value;
                    setFields((all) => all.map((x, j) => (j === i() ? v : x)));
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.isComposing) return;
                    e.preventDefault();
                    confirmByKey(e);
                  }}
                />
              </label>
            )}
          </For>
          <Show when={req.fields?.length && invalid()}>
            <div class="dlg-error">{invalid()}</div>
          </Show>
          <Show when={req.checkbox}>
            {(option) => (
              // A real checkbox under the drawn one: Tab reaches it, Space ticks it, a screen reader says what it is.
              <label class="row" style={{ cursor: "default" }}>
                <input type="checkbox" class="visually-hidden" checked={checked()} onChange={(e) => setChecked(e.currentTarget.checked)} />
                <span class="check" classList={{ on: checked() }} aria-hidden="true">
                  <Icon name="check" size={11} strokeWidth={3} />
                </span>
                <span>{option().label}</span>
              </label>
            )}
          </Show>
          <Show when={required()}>
            {(text) => (
              <div class="dlg-confirm" style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                <label for="dlg-confirm-text" style={{ "font-size": "var(--fs-sm)", color: "var(--text-2)" }}>
                  Type <b class="mono selectable" style={{ color: "var(--text)" }}>{text()}</b> to confirm
                </label>
                <input
                  id="dlg-confirm-text"
                  ref={confirmEl}
                  class="input mono"
                  type="text"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck={false}
                  placeholder={text()}
                  value={typed()}
                  aria-invalid={typed().trim() !== text()}
                  onInput={(e) => setTyped(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.isComposing) return;
                    e.preventDefault();
                    confirmByKey(e);
                  }}
                />
              </div>
            )}
          </Show>
        </div>
        <div class="dlg-foot">
          <button ref={cancelBtn} class="btn ghost" title="Cancel (Esc)" data-hint="escape" data-hint-at="below" onClick={() => finish(false)}>
            Cancel
          </button>
          <button
            class={`btn ${req.danger ? "danger" : "primary"}`}
            disabled={blocked()}
            title={`${req.confirmLabel} (${comboLabel("mod+enter")})`}
            data-hint={blocked() ? undefined : "mod+enter"}
            data-hint-at="below"
            // Keyboard (detail 0) and mouse alike, only once armed — and never the second click of a
            // double-click (detail 2), however slow: the first one may have opened this dialog.
            onClick={(e) => e.detail <= 1 && armed() && finish(true)}
          >
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </Portal>
  );
}
