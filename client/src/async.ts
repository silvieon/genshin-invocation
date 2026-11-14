// A tiny non-suspending alternative to Solid's createResource, used for every
// server lookup so the page never goes blank while waiting.

import { createSignal, type Accessor } from "solid-js";

export interface AsyncValue<T> {
  /** The value once loaded; undefined while loading or on error. */
  (): T | undefined;
  loading: Accessor<boolean>;
  error: Accessor<Error | null>;
}

/**
 * Loads a value without suspending. Unlike createResource under a <Suspense>,
 * the surrounding UI stays on screen while the request is in flight; callers
 * show their own small inline placeholder.
 */
export function fetchValue<T>(load: () => Promise<T>): AsyncValue<T> {
  const [value, setValue] = createSignal<T | undefined>(undefined);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<Error | null>(null);
  load().then(
    (v) => {
      setValue(() => v);
      setLoading(false);
    },
    (e: unknown) => {
      setError(e instanceof Error ? e : new Error(String(e)));
      setLoading(false);
    },
  );
  return Object.assign(() => value(), { loading, error });
}
