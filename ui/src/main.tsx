import "./styles/tokens.css";
import "./styles/app.css";
import { render } from "solid-js/web";
import { type Backend, errorMessage, initBackend } from "./lib/backend";
import { showBootFailure } from "./lib/bootFailure";
import { useFiles } from "./lib/persist";

/** What the UI kept, from the app's files: before the modules that read it as they load. */
async function loadPrefs(backend: Backend) {
  try {
    useFiles(await backend.loadPrefs(), (changes) => backend.setPrefs(changes), () => backend.resetPrefs());
  } catch (e) {
    // The defaults, kept nowhere this time.
    backend.log("error", `could not read the settings: ${errorMessage(e)}`);
    useFiles({ settings: {}, state: {}, settingsError: errorMessage(e), settingsPath: null, statePath: null }, async () => {}, async () => {});
  }
}

async function boot() {
  const backend = await initBackend();
  await loadPrefs(backend);
  // Dev-only handle for poking at the engine from the devtools console.
  if (import.meta.env.DEV) (window as unknown as { __k10s: unknown }).__k10s = { backend };
  // Loaded here, not imported above: the app's state reads saved preferences as its modules load, and whatever
  // still throws there must reach the catch below. A static import that throws stops this module before any of
  // it runs, and the window stays blank.
  const [{ App }, { initApp }] = await Promise.all([import("./App"), import("./state/app")]);
  initApp();
  const root = document.getElementById("root")!;
  root.textContent = "";
  const { version } = await backend.appInfo().catch(() => ({ version: "dev" }));
  render(() => <App version={version} />, root);
}

boot().catch(showBootFailure);
