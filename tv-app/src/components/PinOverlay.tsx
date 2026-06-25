import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";

/**
 * Parental-PIN entry overlay. Extracted verbatim (logic + `lp-pin-*` markup)
 * from the original inline overlay in Live.tsx so both the Adult route and any
 * other adult gate share one implementation.
 *
 * Verifies the entered 4-digit PIN against localStorage `ott_parental_pin`.
 * While open it captures keyboard input (digits, arrows, Enter, Backspace,
 * Escape) ahead of the page so D-pad / keyboard both work on TV and desktop.
 */

const PIN_KEY = "ott_parental_pin";

// PIN keypad navigation rows (3-col digit grid + actions):
//   0..8 = digits 1-9, 9 = C (clear), 10 = digit 0, 11 = ← (backspace),
//   12 = Cancel, 13 = Unlock
const PIN_GRID_ROWS: number[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [9, 10, 11],
  [12, 13],
];

export interface PinOverlayProps {
  open: boolean;
  /** Called with no args once the entered PIN matches the stored PIN. */
  onSuccess: () => void;
  /** Called when the user cancels / dismisses the overlay. */
  onCancel: () => void;
  title?: string;
  subtitle?: string;
}

export default function PinOverlay(props: PinOverlayProps) {
  const [val, setVal] = createSignal("");
  const [err, setErr] = createSignal("");
  const [focusIndex, setFocusIndex] = createSignal(0);

  // Reset entry state every time the overlay opens.
  createEffect((prev) => {
    const open = props.open;
    if (open && !prev) {
      setVal("");
      setErr("");
      setFocusIndex(0);
    }
    return open;
  }, false);

  const submit = () => {
    const stored = localStorage.getItem(PIN_KEY);
    if (val() === stored && stored) {
      setVal("");
      setErr("");
      props.onSuccess();
      return;
    }
    setVal("");
    setErr("Incorrect PIN. Try again.");
  };

  const appendDigit = (d: string) => {
    setVal((v) => (v.length < 4 ? v + d : v));
    setErr("");
  };
  const backspaceDigit = () => {
    setVal((v) => v.slice(0, -1));
    setErr("");
  };

  const activate = (idx: number) => {
    if (idx >= 0 && idx <= 8) appendDigit(String(idx + 1));
    else if (idx === 9) {
      setVal("");
      setErr("");
    } else if (idx === 10) appendDigit("0");
    else if (idx === 11) backspaceDigit();
    else if (idx === 12) props.onCancel();
    else if (idx === 13) submit();
  };

  const moveFocus = (direction: "left" | "right" | "up" | "down") => {
    const cur = focusIndex();
    const rowIdx = PIN_GRID_ROWS.findIndex((r) => r.includes(cur));
    if (rowIdx < 0) {
      setFocusIndex(0);
      return;
    }
    const row = PIN_GRID_ROWS[rowIdx];
    const colIdx = row.indexOf(cur);
    if (direction === "left") {
      setFocusIndex(row[Math.max(0, colIdx - 1)]);
    } else if (direction === "right") {
      setFocusIndex(row[Math.min(row.length - 1, colIdx + 1)]);
    } else if (direction === "up") {
      if (rowIdx === 0) return;
      const prevRow = PIN_GRID_ROWS[rowIdx - 1];
      const ratio = row.length > 1 ? colIdx / (row.length - 1) : 0;
      setFocusIndex(prevRow[Math.round(ratio * (prevRow.length - 1))]);
    } else if (direction === "down") {
      if (rowIdx >= PIN_GRID_ROWS.length - 1) return;
      const nextRow = PIN_GRID_ROWS[rowIdx + 1];
      const ratio = row.length > 1 ? colIdx / (row.length - 1) : 0;
      setFocusIndex(nextRow[Math.round(ratio * (nextRow.length - 1))]);
    }
  };

  // Capture keyboard input ahead of the page while open.
  const onKey = (e: KeyboardEvent) => {
    if (!props.open) return;
    if (e.key >= "0" && e.key <= "9") {
      e.preventDefault();
      e.stopPropagation();
      appendDigit(e.key);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      moveFocus("left");
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      moveFocus("right");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      moveFocus("up");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      moveFocus("down");
    } else if (e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      backspaceDigit();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      activate(focusIndex());
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
    }
  };

  onMount(() => window.addEventListener("keydown", onKey, { capture: true }));
  onCleanup(() => window.removeEventListener("keydown", onKey, { capture: true }));

  return (
    <Show when={props.open}>
      <div class="lp-pin-overlay">
        <div class="lp-pin-modal">
          <div class="lp-pin-icon">🔞</div>
          <h2 class="lp-pin-title">{props.title ?? "Adult Content"}</h2>
          <p class="lp-pin-sub">{props.subtitle ?? "Enter your PIN to continue"}</p>
          <div class="lp-pin-dots">
            <For each={[0, 1, 2, 3]}>
              {(i) => (
                <span class={`lp-pin-dot${i < val().length ? " filled" : ""}`} />
              )}
            </For>
          </div>
          <Show when={err()}>
            <div class="lp-pin-err">{err()}</div>
          </Show>
          <div class="lp-pin-keypad">
            <For each={[1, 2, 3, 4, 5, 6, 7, 8, 9]}>
              {(n) => (
                <button
                  type="button"
                  class={`lp-pin-key${focusIndex() === n - 1 ? " focused" : ""}`}
                  onClick={() => activate(n - 1)}
                >
                  {n}
                </button>
              )}
            </For>
            <button
              type="button"
              class={`lp-pin-key lp-pin-key--muted${focusIndex() === 9 ? " focused" : ""}`}
              onClick={() => activate(9)}
            >
              C
            </button>
            <button
              type="button"
              class={`lp-pin-key${focusIndex() === 10 ? " focused" : ""}`}
              onClick={() => activate(10)}
            >
              0
            </button>
            <button
              type="button"
              class={`lp-pin-key lp-pin-key--muted${focusIndex() === 11 ? " focused" : ""}`}
              onClick={() => activate(11)}
            >
              ←
            </button>
          </div>
          <div class="lp-pin-actions">
            <button
              type="button"
              class={`lp-pin-action${focusIndex() === 12 ? " focused" : ""}`}
              onClick={() => activate(12)}
            >
              Cancel
            </button>
            <button
              type="button"
              class={`lp-pin-action lp-pin-action--primary${focusIndex() === 13 ? " focused" : ""}`}
              onClick={() => activate(13)}
              disabled={val().length !== 4}
            >
              Unlock
            </button>
          </div>
          <p class="lp-pin-hint">Use digits or keypad to enter PIN.</p>
        </div>
      </div>
    </Show>
  );
}
