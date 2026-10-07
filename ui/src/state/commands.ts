import type { IconName } from "../components/Icon";

/**
 * Command palette registry. Providers are called with the current query and return commands;
 * anything (resources, clusters, actions, plugins) can contribute with `registerCommands`.
 */
export interface Command {
  id: string;
  title: string;
  section: string;
  icon?: IconName;
  /** Extra strings matched by the fuzzy search (short names, groups…). */
  keywords?: string[];
  hint?: string;
  /** The key that runs it, shown next to it: a command of the keymap's, as it is now (`keyOf`). */
  shortcut?: string;
  color?: string;
  checked?: boolean;
  /** `additive` is true when invoked with ⌘/Ctrl+Enter (e.g. add a cluster instead of switching). */
  run(opts: { additive: boolean }): void | Promise<void>;
  /** Higher = earlier when scores tie (and for empty queries). */
  priority?: number;
}

export type CommandProvider = (query: string) => Command[];

const providers = new Set<CommandProvider>();

export function registerCommands(provider: CommandProvider): () => void {
  providers.add(provider);
  return () => providers.delete(provider);
}

export function collectCommands(query: string): Command[] {
  const out: Command[] = [];
  for (const p of providers) out.push(...p(query));
  return out;
}
