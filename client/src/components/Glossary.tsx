import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { loadGlossary } from "../assets";

export function Glossary() {
  const [data] = createResource(loadGlossary);
  const [query, setQuery] = createSignal("");
  const q = () => query().trim().toLowerCase();

  const keywords = createMemo(() =>
    (data()?.keywords ?? []).filter(
      (k) => !q() || k.name.toLowerCase().includes(q()) || k.description.toLowerCase().includes(q()),
    ),
  );
  const rules = createMemo(() =>
    (data()?.rules ?? [])
      .map((set) => ({
        ...set,
        rules: set.rules.filter(
          (r) => !q() || r.title.toLowerCase().includes(q()) || r.content.toLowerCase().includes(q()),
        ),
      }))
      .filter((s) => s.rules.length > 0),
  );

  return (
    <div class="glossary">
      <input
        class="search"
        type="search"
        placeholder="Search keywords and reactions…"
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      <Show when={!data.error} fallback={<p class="error">The glossary couldn't be loaded.</p>}>
        <Show when={data()} fallback={<p class="muted">Loading…</p>}>
          <For each={rules()}>
            {(set) => (
              <details open={!!q()}>
                <summary>{set.name}</summary>
                <dl>
                  <For each={set.rules}>
                    {(r) => (
                      <>
                        <dt>{r.title}</dt>
                        <dd>{r.content}</dd>
                      </>
                    )}
                  </For>
                </dl>
              </details>
            )}
          </For>
          <h4>Keywords</h4>
          <dl>
            <For each={keywords()}>
              {(k) => (
                <>
                  <dt>{k.name}</dt>
                  <dd>{k.description}</dd>
                </>
              )}
            </For>
          </dl>
          <Show when={keywords().length === 0 && rules().length === 0}>
            <p class="muted">Nothing matches “{query()}”.</p>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
