import { type Accessor, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { Icon } from "../../components/Icon";
import { Highlight } from "../../components/Popover";
import { count } from "../../lib/format";
import { applyAt, type Spot, spotAt } from "../../lib/logs/complete";
import { describeQuery, type Query } from "../../lib/logs/query";
import { indexAtPos } from "../logBuffer";
import type { LogCtx } from "./LogViewer";
import { filterMode, matchCase, queryHistory, regexMode, rememberQuery, setFilterMode, setMatchCase, setRegexMode } from "./model";
import { Catalog, type Suggestion } from "./suggest";

const HELP = [
  "error timeout — lines with both words (any case)",
  '"connection refused" — the words together',
  "!healthz — leave lines out",
  "/time.?out/ — a regular expression",
  "level:error · level>=warn",
  "status>=500 · path:/api · user=bob — fields of JSON and logfmt lines",
  "pod:web-7f · container:app · cluster:z2",
  "a,b — one of them · * — anything",
  "Fields and their values are suggested as you type: Enter or Tab takes the one highlighted (⌃Space asks)",
].join("\n");

/** Suggestions are made from what the lines held were this recently (they come in all the time). */
const CATALOG_MS = 1000;

/**
 * The query: typed into a field that colours its terms and suggests fields and their values, with the options
 * (match case, regular expression, filter or find) and — finding — the matches' count and the way to the next one.
 */
export function QueryField(props: {
  ctx: LogCtx;
  /** The query as typed (it may not be applied yet: a big log is filtered once typing pauses). */
  query: Accessor<Query>;
  text: Accessor<string>;
  setText: (s: string) => void;
  ref: (el: HTMLInputElement) => void;
  jump: (dir: 1 | -1) => void;
  /** Applies what is typed now. */
  flush: () => void;
}) {
  const c = props.ctx;
  let input!: HTMLInputElement;
  let overlay!: HTMLDivElement;
  let box!: HTMLDivElement;
  let list: HTMLDivElement | undefined;
  const [focused, setFocused] = createSignal(false);
  // Going through the history with ↑/↓: where, and what was typed before.
  let at = -1;
  let typed = "";
  /** Width of a character of the input (monospaced): the suggestions open under what they complete. */
  let charW = 7;
  onMount(() => {
    const g = document.createElement("canvas").getContext("2d");
    if (!g) return;
    g.font = getComputedStyle(input).font;
    charW = g.measureText("0123456789").width / 10 || 7;
  });

  const sync = () => {
    if (overlay) overlay.scrollLeft = input.scrollLeft;
  };
  /** The input as coloured pieces. */
  const spans = createMemo(() => {
    const q = props.query();
    const text = props.text();
    const out: { text: string; kind?: string }[] = [];
    let pos = 0;
    for (const [s, e, kind] of [...q.spans].sort((a, b) => a[0] - b[0])) {
      if (s < pos) continue;
      if (s > pos) out.push({ text: text.slice(pos, s) });
      out.push({ text: text.slice(s, e), kind });
      pos = e;
    }
    if (pos < text.length) out.push({ text: text.slice(pos) });
    return out;
  });
  const finding = () => !filterMode() && c.queryOn();
  const position = createMemo(() => {
    const m = c.matches();
    if (!m) return null;
    const sel = c.selected();
    const k = sel ? indexAtPos(m, sel.pos) : -1;
    return { at: sel && m[k] === sel ? k : -1, total: m.length };
  });

  // ------------------------------------------------------------------ suggestions
  /**
   * What is suggested where the caret is: the one highlighted (-1: none) is what Enter takes; `picked`: the keys or the
   * mouse picked it.
   */
  const [sg, setSg] = createSignal<{ spot: Spot; items: Suggestion[]; index: number; picked: boolean; left: number } | null>(null);
  let catalog: { at: number; version: number; it: Catalog } | undefined;
  const catalogNow = () => {
    const v = c.version();
    const now = Date.now();
    if (!catalog || (catalog.version !== v && now - catalog.at > CATALOG_MS)) catalog = { at: now, version: v, it: new Catalog(c) };
    return catalog.it;
  };
  /** Suggests for the caret's spot (`explicit`: asked for — between terms too, and what is typed whole). */
  const suggest = (explicit = false) => {
    const caret = input.selectionStart ?? input.value.length;
    if (regexMode() || document.activeElement !== input || caret !== input.selectionEnd) return setSg(null);
    const spot = spotAt(input.value, caret, explicit);
    if (!spot) return setSg(null);
    const items = catalogNow().at(spot);
    if (!items.length) return setSg(null);
    if (!explicit) {
      // Typing a word some field's name merely contains is not typing a field.
      if (spot.kind === "key" && items[0].score === 2) return setSg(null);
      // Nothing to add to it.
      if (spot.kind === "value" && items.length === 1 && items[0].text.toLowerCase() === spot.prefix.toLowerCase()) return setSg(null);
    }
    // The best one is highlighted once something is typed that it completes. Right after an operator nothing is (Enter
    // applies the query as it is: `key:`, lines with the field); a value typed whole has nothing to complete.
    const whole = items[0].text.toLowerCase() === spot.prefix.toLowerCase();
    let index = spot.prefix && !(spot.kind === "value" && whole) ? 0 : -1;
    // One picked stays picked while it is still there.
    const prev = sg();
    const keep = prev?.picked ? items.findIndex((x) => x.text === prev.items[prev.index]?.text) : -1;
    if (keep >= 0) index = keep;
    const left = Math.max(0, Math.min(box.clientWidth - 200, spot.from * charW - input.scrollLeft - 6));
    setSg({ spot, items, index, picked: keep >= 0, left });
  };
  const accept = (k: number) => {
    const s = sg();
    const it = s?.items[k];
    if (!s || !it) return;
    const r = applyAt(input.value, s.spot, it.text);
    at = -1;
    setSg(null);
    props.setText(r.input);
    input.value = r.input;
    input.setSelectionRange(r.caret, r.caret);
    sync();
    // A field's name: its values next.
    if (s.spot.kind === "key") suggest(true);
  };
  const moveTo = (index: number) => {
    const s = sg();
    if (!s) return;
    const n = s.items.length;
    setSg({ ...s, index: ((index % n) + n) % n, picked: true });
    queueMicrotask(() => list?.querySelector(".opt.hl")?.scrollIntoView?.({ block: "nearest" }));
  };

  const onKey = (e: KeyboardEvent) => {
    const s = sg();
    if (s) {
      const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key === "ArrowDown" || (ctrl && e.key === "n")) {
        e.preventDefault();
        return moveTo(s.index + 1);
      }
      if (e.key === "ArrowUp" || (ctrl && e.key === "p")) {
        e.preventDefault();
        return moveTo(s.index < 0 ? s.items.length - 1 : s.index - 1);
      }
      // Enter takes the one highlighted (none: the query is applied as it is); Tab, the first if none is.
      if ((e.key === "Enter" && s.index >= 0) || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        return accept(Math.max(0, s.index));
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return setSg(null);
      }
    }
    if (e.key === " " && e.ctrlKey) {
      e.preventDefault();
      return suggest(true);
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      // ⌥C / ⌥R / ⌥F, as in editors' find bars (by key position: ⌥ types other characters).
      const toggle = { KeyC: () => setMatchCase(!matchCase()), KeyR: () => setRegexMode(!regexMode()), KeyF: () => setFilterMode(!filterMode()) }[e.code];
      if (toggle) {
        e.preventDefault();
        toggle();
        return;
      }
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const list = queryHistory();
      if (!list.length) return;
      e.preventDefault();
      if (at < 0) typed = props.text();
      at = e.key === "ArrowUp" ? Math.min(list.length - 1, at + 1) : at - 1;
      props.setText(at < 0 ? typed : list[at]);
      queueMicrotask(() => {
        input.setSelectionRange(input.value.length, input.value.length);
        sync();
      });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      setSg(null);
      props.flush();
      rememberQuery(props.text());
      // Finding: Enter goes to the next match (⇧Enter the previous); filtering, it hands the keys back to the lines.
      if (finding()) props.jump(e.shiftKey ? -1 : 1);
      else input.blur();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (props.text()) props.setText("");
      else input.blur();
    }
  };
  /** The caret moved: the suggestions (when shown) follow it, or go. */
  const caretMoved = (e: Event) => {
    sync();
    if (sg() && !(e instanceof KeyboardEvent && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Tab" || e.key === "Enter"))) suggest();
  };

  return (
    <div class="lq" classList={{ invalid: !!props.query().error, focused: focused(), finding: !filterMode() }} data-hint="/" data-hint-ctx="details" title={sg() ? undefined : props.query().terms.length || props.query().error ? describeQuery(props.query()) : HELP}>
      <Icon name={filterMode() ? "filter" : "search"} size={12} />
      <div class="lq-box" ref={box}>
        <div class="lq-overlay" ref={overlay} aria-hidden="true">
          <For each={spans()}>{(s) => (s.kind ? <span class={`q-${s.kind}`}>{s.text}</span> : s.text)}</For>
        </div>
        <input
          ref={(el) => {
            input = el;
            props.ref(el);
          }}
          class="lq-input"
          spellcheck={false}
          autocomplete="off"
          role="combobox"
          aria-expanded={!!sg()}
          aria-autocomplete="list"
          placeholder={filterMode() ? "Filter: words, !word, key:value, /regex/" : "Find: words, !word, key:value, /regex/"}
          value={props.text()}
          onInput={(e) => {
            at = -1;
            props.setText(e.currentTarget.value);
            sync();
            suggest();
          }}
          onKeyDown={onKey}
          onKeyUp={caretMoved}
          onClick={caretMoved}
          onScroll={sync}
          onSelect={sync}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setSg(null);
            rememberQuery(props.text());
          }}
        />
        <Show when={sg()}>
          {(s) => (
            <div class="lq-sg" ref={list} role="listbox" style={{ left: `${s().left}px` }} onMouseDown={(e) => e.preventDefault()}>
              <div class="pop-group">
                {(() => {
                  const sp = s().spot;
                  return sp.kind === "key" ? "Fields" : `${sp.key}${sp.op}`;
                })()}
              </div>
              <For each={s().items}>
                {(it, k) => (
                  <div
                    class="opt"
                    role="option"
                    aria-selected={k() === s().index}
                    classList={{ hl: k() === s().index }}
                    onMouseMove={(e) => (e.movementX || e.movementY) && k() !== s().index && moveTo(k())}
                    onClick={() => accept(k())}
                  >
                    <span class="lq-sg-text ellipsis">
                      <Highlight text={it.text} indices={it.at} />
                    </span>
                    <Show when={it.hint}>
                      <span class="sub">{it.hint}</span>
                    </Show>
                    <Show when={it.count !== undefined}>
                      <span class="lq-sg-n">{count(it.count!)}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
      </div>
      <Show when={finding() && position()}>
        <span class="lq-count" classList={{ none: position()!.total === 0 }}>
          {position()!.total === 0 ? "no matches" : position()!.at >= 0 ? `${count(position()!.at + 1)} of ${count(position()!.total)}` : `${count(position()!.total)} found`}
        </span>
        <button class="lq-opt" title="Previous match (⇧Enter, ⇧N)" onClick={() => props.jump(-1)}>
          <Icon name="chevron-up" size={11} />
        </button>
        <button class="lq-opt" title="Next match (Enter, N)" onClick={() => props.jump(1)}>
          <Icon name="chevron-down" size={11} />
        </button>
      </Show>
      <button class="lq-opt" classList={{ on: matchCase() }} title="Match case (⌥C)" onClick={() => setMatchCase(!matchCase())}>
        Aa
      </button>
      <button class="lq-opt" classList={{ on: regexMode() }} title="The whole query is one regular expression (⌥R); !… leaves its matches out" onClick={() => setRegexMode(!regexMode())}>
        .*
      </button>
      <button class="lq-opt" classList={{ on: filterMode() }} title={filterMode() ? "Filtering: only matching lines are shown. Click to find instead — all lines stay, matches are highlighted (⌥F)" : "Finding: matches are highlighted, N goes to the next. Click to show only matching lines (⌥F)"} onClick={() => setFilterMode(!filterMode())}>
        <Icon name="filter" size={11} />
      </button>
    </div>
  );
}
