import { ErrorBoundary, type JSX, untrack } from "solid-js";
import { reportError } from "../lib/errors";
import { Icon } from "./Icon";

/**
 * Contains a failure to one region of the UI. Without boundaries, an exception thrown during a
 * reactive update makes Solid drop the rest of that update's DOM effects — the app looks frozen.
 */
export function Boundary(props: { where: string; children: JSX.Element; silent?: boolean; onError?: () => void }) {
  return (
    <ErrorBoundary
      fallback={(err, reset) => {
        untrack(() => {
          reportError(err, props.where);
          if (props.onError) queueMicrotask(props.onError);
        });
        if (props.silent) return null;
        return (
          <div class="boundary">
            <Icon name="alert" size={16} />
            <div class="grow">
              <div style={{ "font-weight": 600 }}>Something went wrong in {props.where}</div>
              <div class="faint selectable">{err instanceof Error ? err.message : String(err)}</div>
            </div>
            <button class="btn sm" onClick={reset}>
              Retry
            </button>
          </div>
        );
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}
