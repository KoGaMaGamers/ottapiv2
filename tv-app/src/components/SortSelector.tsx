import { For } from "solid-js";

export interface SortOption<T extends string> {
  value: T;
  label: string;
}

export interface SortSelectorProps<T extends string> {
  value: () => T;
  options: SortOption<T>[];
  onChange: (value: T) => void;
  isFocused: () => boolean;
  /** Index of the focused pill within the row when this scope is active. */
  focusedIdx: () => number;
}

/**
 * Horizontal pill row for picking a sort order. Pure presentational —
 * the parent page owns key handling and the focused index.
 *
 * Keyboard contract (handled by the parent):
 *   ←/→  cycle pills
 *   Enter / Space  call onChange(options[focusedIdx].value)
 */
export default function SortSelector<T extends string>(props: SortSelectorProps<T>) {
  return (
    <div class="px-8 py-3 flex items-center gap-2">
      <span class="text-xs text-zinc-500 uppercase tracking-wider mr-1">
        Sort
      </span>
      <For each={props.options}>
        {(opt, i) => {
          const isActive = () => props.value() === opt.value;
          const focused = () => props.isFocused() && props.focusedIdx() === i();
          return (
            <button
              onClick={() => props.onChange(opt.value)}
              class={`px-3 py-1 rounded-full text-xs font-medium transition-colors outline-none ${
                isActive()
                  ? "bg-violet-600/30 text-violet-200 ring-1 ring-violet-500"
                  : "bg-zinc-900 text-zinc-400 ring-1 ring-zinc-800 hover:text-zinc-200"
              } ${focused() ? "ring-2 ring-violet-300" : ""}`}
            >
              {opt.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}
