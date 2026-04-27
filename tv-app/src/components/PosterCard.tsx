import { createEffect, type JSX } from "solid-js";

/**
 * Single tile in a rail or grid. Pure presentational — the parent owns
 * focus state and click semantics. When `focused()` is true, the card
 * scrolls itself into view on the rail track (matches the legacy
 * `scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })`
 * UX from `tv_app_v2/components/MovieCard.jsx`).
 */
export interface PosterCardProps {
  title: string;
  imageUrl?: string | null;
  /** Reactive focus state. Card highlights + scrolls into view on focus. */
  focused: () => boolean;
  /** Optional small badges (year, rating, language…) above the title. */
  meta?: JSX.Element;
  /** Aspect ratio: "2/3" portrait poster (default), "16/9" landscape, "1/1" square. */
  aspect?: "2/3" | "16/9" | "1/1";
  onClick?: () => void;
}

export default function PosterCard(props: PosterCardProps) {
  let ref: HTMLDivElement | undefined;

  createEffect(() => {
    if (props.focused() && ref) {
      ref.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    }
  });

  const aspect = () => props.aspect ?? "2/3";
  const aspectClass = () => {
    switch (aspect()) {
      case "16/9":
        return "aspect-video";
      case "1/1":
        return "aspect-square";
      default:
        return "aspect-[2/3]";
    }
  };

  // 2-letter placeholder when no image
  const placeholder = () => props.title.trim().slice(0, 2).toUpperCase() || "··";

  return (
    <div
      ref={ref}
      onClick={props.onClick}
      class={`flex-shrink-0 w-44 cursor-pointer transition-transform duration-200 ${
        props.focused() ? "scale-105" : "scale-100"
      }`}
    >
      <div
        class={`${aspectClass()} relative rounded-lg overflow-hidden bg-zinc-900 ring-2 transition-shadow duration-200 ${
          props.focused()
            ? "ring-violet-400 shadow-lg shadow-violet-900/40"
            : "ring-zinc-800"
        }`}
      >
        {props.imageUrl ? (
          <img
            src={props.imageUrl}
            alt={props.title}
            loading="lazy"
            class="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div class="absolute inset-0 flex items-center justify-center text-3xl font-semibold text-zinc-600 select-none">
            {placeholder()}
          </div>
        )}
      </div>
      {props.meta && <div class="mt-1 px-1 text-[11px] text-zinc-500">{props.meta}</div>}
      <p
        class={`mt-1 px-1 text-sm truncate transition-colors ${
          props.focused() ? "text-white" : "text-zinc-400"
        }`}
      >
        {props.title}
      </p>
    </div>
  );
}
