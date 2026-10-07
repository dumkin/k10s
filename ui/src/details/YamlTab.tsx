import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Icon } from "../components/Icon";
import { backend, errorMessage } from "../lib/backend";
import { type Binding, bindAll, withKeys } from "../lib/hotkeys";
import { keyOf } from "../lib/keymap";
import { blockMask, type Token, tokenizeLine } from "../lib/yaml";
import { type DetailProps, deferReady } from "../registry/details";
import { detailsHaveKeyboard } from "../state/keyboard";
import { CodeView } from "./CodeView";
import { CopyButton, createSafeResource } from "./common";

/** A core Secret: the engine hides its values in YAML unless asked to reveal them. */
const isSecret = (props: DetailProps) => props.resourceKey === "secrets" || (props.resource?.group === "" && props.resource?.kind === "Secret");

export function YamlTab(props: DetailProps) {
  const [managed, setManaged] = createSignal(false);
  // Off for every object anew: revealing one Secret must not reveal the next one shown (j/k, a sticky tab).
  const [reveal, setReveal] = createSignal(false);
  createEffect(on(() => `${props.target.cluster}/${props.target.resource}/${props.target.namespace ?? ""}/${props.target.name}`, () => setReveal(false), { defer: true }));
  const yaml = createSafeResource(
    () => ({ target: props.target, rv: props.row.rv, managed: managed(), reveal: isSecret(props) && reveal() }),
    async ({ target, managed, reveal }) => ({ yaml: await backend().getYaml(target, managed, reveal), revealed: reveal }),
  );
  // The last text fetched stays while the next one loads (or fails) — unless it has revealed values and
  // they are hidden now: those go at once, not when (if ever) the hidden text arrives.
  const shown = () => {
    const v = yaml.value();
    return v && (!v.revealed || reveal()) ? v.yaml : undefined;
  };
  const text = () => shown() ?? "";
  // The panel keeps showing the previous object until the text is here (or could not be read).
  const ready = deferReady();
  createEffect(() => (yaml.value() || yaml.error()) && ready());
  const lines = createMemo(() => {
    const l = text().split("\n");
    if (l.length && l[l.length - 1] === "") l.pop();
    return l;
  });
  const mask = createMemo(() => blockMask(lines()));
  // Tokens per line, kept for the current text: "Find in YAML" re-renders the visible lines on every keystroke.
  const tokenCache = createMemo(() => (lines(), mask(), new Map<number, Token[]>()));
  const tokensOf = (i: number): Token[] => {
    const cache = tokenCache();
    let tokens = cache.get(i);
    if (!tokens) {
      if (cache.size > 20_000) cache.clear();
      cache.set(i, (tokens = tokenizeLine(lines()[i] ?? "", mask()[i])));
    }
    return tokens;
  };

  const [query, setQuery] = createSignal("");
  const [current, setCurrent] = createSignal(0);
  const matches = createMemo(() => {
    const q = query().toLowerCase();
    if (!q) return [] as number[];
    const out: number[] = [];
    lines().forEach((l, i) => l.toLowerCase().includes(q) && out.push(i));
    return out;
  });
  let api: { scrollToLine(i: number): void } | undefined;
  createEffect(on(query, () => setCurrent(0)));
  createEffect(() => {
    const m = matches();
    if (m.length) api?.scrollToLine(m[Math.min(current(), m.length - 1)]);
  });
  const step = (d: number) => {
    const n = matches().length;
    if (n) setCurrent((c) => (c + d + n) % n);
  };
  const matchSet = createMemo(() => new Set(matches()));

  // While the details have the keyboard (full view, or focus in them): / finds, n / N go through the matches.
  let findEl: HTMLInputElement | undefined;
  onMount(() => {
    const focusFind = () => {
      findEl?.focus();
      findEl?.select();
    };
    const go = (d: number) => () => {
      if (!matches().length) return false;
      step(d);
    };
    onCleanup(
      bindAll(
        (
          [
            { id: "yaml.find", inInputs: true, run: focusFind },
            { id: "yaml.next-match", run: go(1) },
            { id: "yaml.previous-match", run: go(-1) },
          ] satisfies Binding[]
        ).map((b) => ({ ...b, when: detailsHaveKeyboard })),
      ),
    );
  });

  const renderLine = (i: number) => {
    const q = query().toLowerCase();
    return (
      <For each={tokensOf(i)}>
        {(t) => {
          const idx = q ? t.text.toLowerCase().indexOf(q) : -1;
          if (idx < 0) return <span class={`y-${t.kind}`}>{t.text}</span>;
          return (
            <span class={`y-${t.kind}`}>
              {t.text.slice(0, idx)}
              <mark>{t.text.slice(idx, idx + q.length)}</mark>
              {t.text.slice(idx + q.length)}
            </span>
          );
        }}
      </For>
    );
  };

  return (
    <>
      <div class="toolbar">
        <div class="search-field" style={{ width: "220px" }} data-hint={keyOf("yaml.find")} data-hint-ctx="details">
          <Icon name="search" size={13} />
          <input
            ref={findEl}
            class="input"
            style={{ height: "24px" }}
            placeholder="Find in YAML"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") step(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") (e.currentTarget.blur(), setQuery(""));
            }}
          />
        </div>
        <Show when={query()}>
          <span class="faint" style={{ "font-size": "var(--fs-xs)", "min-width": "44px" }}>
            {matches().length ? `${Math.min(current() + 1, matches().length)}/${matches().length}` : "0/0"}
          </span>
          <button
            class="btn sm ghost icon"
            onClick={() => step(-1)}
            title={withKeys("Previous match", "yaml.previous-match", "shift+enter")}
            data-hint={keyOf("yaml.previous-match")}
            data-hint-ctx="details"
            data-hint-at="below"
          >
            <Icon name="chevron-up" size={13} />
          </button>
          <button class="btn sm ghost icon" onClick={() => step(1)} title={withKeys("Next match", "yaml.next-match", "enter")} data-hint={keyOf("yaml.next-match")} data-hint-ctx="details" data-hint-at="below">
            <Icon name="chevron-down" size={13} />
          </button>
        </Show>
        <span class="grow" />
        <Show when={yaml.loading()}>
          <span class="spinner" />
        </Show>
        <Show when={isSecret(props)}>
          <button
            class="btn sm ghost"
            classList={{ on: reveal() }}
            aria-pressed={reveal()}
            onClick={() => setReveal(!reveal())}
            title={reveal() ? "Hide the Secret's values again" : "Show the Secret's values (data, stringData, last-applied-configuration)"}
          >
            <Icon name={reveal() ? "eye-off" : "eye"} size={12} />
            {reveal() ? "Hide values" : "Reveal values"}
          </button>
        </Show>
        <button class="btn sm ghost" classList={{ on: managed() }} onClick={() => setManaged(!managed())} title="Include metadata.managedFields">
          managedFields
        </button>
        <button class="btn sm ghost icon" title="Reload" onClick={() => void yaml.refetch()}>
          <Icon name="refresh" size={12} />
        </button>
        {/* Copies what is shown: hidden values stay hidden. */}
        <CopyButton text={text} />
      </div>
      <Show when={yaml.error() && shown() === undefined}>
        <div class="section error-text">{errorMessage(yaml.error())}</div>
      </Show>
      <CodeView count={lines().length} renderLine={renderLine} ref={(a) => (api = a)} lineClass={(i) => (matchSet().has(i) ? "match" : "")} />
    </>
  );
}
