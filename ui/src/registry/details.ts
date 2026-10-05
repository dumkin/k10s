import { type Component, createContext, onCleanup, useContext } from "solid-js";
import type { IconName } from "../components/Icon";
import type { ObjectRef, ResourceInfo } from "../lib/backend";
import type { UIRow } from "../state/view";

/**
 * Tabs of the details panel. Each tab declares which resources it applies to; add new ones
 * (shell, metrics, port-forward, diff across clusters…) with `registerDetailTab`.
 */
export interface DetailProps {
  row: UIRow;
  resourceKey: string;
  resource?: ResourceInfo;
  target: ObjectRef;
}

export interface DetailTab {
  id: string;
  title: string;
  icon: IconName;
  shortcut?: string;
  order: number;
  when(resourceKey: string, resource?: ResourceInfo): boolean;
  component: Component<DetailProps>;
  /** The tab manages its own scrolling (logs, YAML). */
  flush?: boolean;
}

const tabs: DetailTab[] = [];

export function registerDetailTab(tab: DetailTab) {
  const i = tabs.findIndex((t) => t.id === tab.id);
  if (i >= 0) tabs[i] = tab;
  else tabs.push(tab);
  tabs.sort((a, b) => a.order - b.order);
}

export function tabsFor(resourceKey: string, resource?: ResourceInfo): DetailTab[] {
  return tabs.filter((t) => t.when(resourceKey, resource));
}

/**
 * A tab that shows nothing until it has loaded (the Overview waits for the object) can say when it is ready: the
 * details keep showing the previous object until then (for a moment at most), instead of going blank in between.
 * Call it while the tab is set up; call what it returns once there is something to show (or an error). A tab that
 * never calls it is ready as soon as it is mounted.
 */
export const DetailReadyContext = createContext<() => () => void>(() => () => {});

/**
 * See {@link DetailReadyContext}: returns the function to call once the tab has something to show. A tab that goes
 * before it said so (another tab picked) gives its wait back.
 */
export function deferReady(): () => void {
  const done = useContext(DetailReadyContext)();
  onCleanup(done);
  return done;
}
