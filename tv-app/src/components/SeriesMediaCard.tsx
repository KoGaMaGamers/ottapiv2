/**
 * SeriesMediaCard — portrait poster card for TV series.
 *
 * Faithful Solid port of `tv_app_v2/src/components/SeriesMediaCard.jsx`.
 * 2:3 portrait poster, focus-meta overlay (badges + genres), no
 * progress bar (series resume sits at the episode level, not the
 * series level).
 *
 * Image source priority:  poster > logo
 */

import { createMemo, createEffect, Show, For, type JSX } from "solid-js";
import { type CardItem, toGenreLabels } from "./cardItem";

export interface SeriesMediaCardProps {
  item: CardItem;
  focused?: boolean;
  onClick?: (item: CardItem) => void;
}

export default function SeriesMediaCard(
  props: SeriesMediaCardProps,
): JSX.Element {
  let ref: HTMLDivElement | undefined;

  const title = () => props.item?.title || props.item?.name || "";
  const poster = () => props.item?.poster || props.item?.logo || null;
  const language = () =>
    props.item?.language ? String(props.item.language).toUpperCase() : null;
  const year = () => (props.item?.year ? String(props.item.year) : null);
  const rating = () => {
    const r = props.item?.rating;
    return r == null ? null : Number(r);
  };
  const genres = createMemo(() => toGenreLabels(props.item?.genres, 3));

  createEffect(() => {
    if (!props.focused || !ref) return;
    ref.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "smooth",
    });
  });

  return (
    <div
      ref={(el) => (ref = el)}
      class={`mc-card mc-card--series${props.focused ? " is-focused" : ""}`}
      onClick={() => props.onClick?.(props.item)}
    >
      <div class="mc-media">
        <Show
          when={poster()}
          fallback={
            <div class="mc-media-fallback">
              {(title() || "?").charAt(0).toUpperCase()}
            </div>
          }
        >
          <img
            src={poster()!}
            alt={title()}
            class="mc-media-img"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        </Show>
        <div class="mc-focus-meta">
          <div class="mc-focus-badges">
            <span class="mc-chip mc-chip--type-series">SERIES</span>
            <Show when={year()}>
              <span class="mc-chip mc-chip--year">{year()}</span>
            </Show>
            <Show when={language()}>
              <span class="mc-chip mc-chip--language">{language()}</span>
            </Show>
            <Show when={rating() != null && Number.isFinite(rating()!)}>
              <span class="mc-chip mc-chip--rating">
                ★ {rating()!.toFixed(1)}
              </span>
            </Show>
          </div>
          <Show when={genres().length > 0}>
            <div class="mc-focus-genres">
              <For each={genres()}>
                {(g) => <span class="mc-chip mc-chip--genre">{g}</span>}
              </For>
            </div>
          </Show>
        </div>
      </div>
      <div class="mc-title-row">
        <p class="mc-title">{title()}</p>
        <Show when={language()}>
          <span class="mc-title-language">{language()}</span>
        </Show>
      </div>
    </div>
  );
}
