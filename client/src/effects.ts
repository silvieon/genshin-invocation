// Board animation speed.
//
// The board drives its card and damage motion with the Web Animations API and
// waits for each animation to finish before showing the next game event, so
// shortening them makes the game itself advance faster, not just look snappier.

import { getEffects } from "./local";

/** Fast mode: a third of the original length, never more than 300 ms. */
const FAST_SCALE = 0.35;
const FAST_MAX_MS = 300;

export function applyEffectsMode() {
  const mode = getEffects();
  if (mode === "full") return;
  // No backdrop blur in either reduced mode: it's the costliest effect on phones.
  document.documentElement.classList.add(mode === "off" ? "fx-off" : "fx-fast");
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (keyframes, options) {
    const opts: KeyframeAnimationOptions = typeof options === "number" ? { duration: options } : { ...options };
    if (mode === "off") {
      opts.duration = 0;
      opts.delay = 0;
      opts.endDelay = 0;
      if (opts.iterations === Infinity) opts.iterations = 1;
    } else {
      const d = typeof opts.duration === "number" ? opts.duration : 0;
      opts.duration = Math.min(d * FAST_SCALE, FAST_MAX_MS);
      opts.delay = Math.min((opts.delay ?? 0) * FAST_SCALE, FAST_MAX_MS);
      opts.endDelay = Math.min((opts.endDelay ?? 0) * FAST_SCALE, FAST_MAX_MS);
    }
    return animate.call(this, keyframes, opts);
  };
}
