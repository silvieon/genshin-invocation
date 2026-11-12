import { render } from "solid-js/web";
import "@gi-tcg/web-ui-core/style.css";
import "@gi-tcg/deck-builder/style.css";
import "./styles.css";
import { App } from "./App";
import { applyEffectsMode } from "./effects";

applyEffectsMode();

render(() => <App />, document.getElementById("app")!);

// Card art caching + fallback (see public/sw.js). Failure to register is harmless.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
