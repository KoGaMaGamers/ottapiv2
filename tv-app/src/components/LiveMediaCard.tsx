/**
 * LiveMediaCard — circular logo card for live TV channels.
 *
 * Faithful Solid port of `tv_app_v2/src/components/LiveMediaCard.jsx`.
 * Round 72×72 (or 58×58 in compact mode) channel logo with badges
 * rendered below the title (rather than overlaid like the VOD cards).
 *
 * Image source priority:  poster > channel_logo > logo > stream_icon
 */

import { createMemo, createEffect, Show, For, type JSX } from "solid-js";
import { type CardItem, toGenreLabels } from "./cardItem";

export interface LiveMediaCardProps {
  item: CardItem;
  focused?: boolean;
  onClick?: (item: CardItem) => void;
  compact?: boolean;
}

export default function LiveMediaCard(props: LiveMediaCardProps): JSX.Element {
  let ref: HTMLDivElement | undefined;

  const title = () => props.item?.title || props.item?.name || "";
  const logo = () =>
    props.item?.poster ||
    props.item?.channel_logo ||
    props.item?.logo ||
    props.item?.stream_icon ||
    null;
  const language = () =>
    props.item?.language ? String(props.item.language).toUpperCase() : null;
  const year = () => (props.item?.year ? String(props.item.year) : null);
  // Live cards cap genre chips at 2 (not 3) to fit the compact layout.
  const genres = createMemo(() => toGenreLabels(props.item?.genres, 2));

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
      class={`mc-card mc-card--live${props.focused ? " is-focused" : ""}${
        props.compact ? " is-compact" : ""
      }`}
      onClick={() => props.onClick?.(props.item)}
    >
      <div class="mc-media mc-media--circle">
        <Show
          when={logo()}
          fallback={
            <div class="mc-media-fallback">
              {(title() || "?").charAt(0).toUpperCase()}
            </div>
          }
        >
          <img
            src={logo()!}
            alt={title()}
            class="mc-media-img"
            loading="lazy"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        </Show>
      </div>
      <p class="mc-title">{title()}</p>
      <div class="mc-focus-meta mc-focus-meta--live">
        <div class="mc-focus-badges">
          <span class="mc-chip mc-chip--type-live">LIVE</span>
          <Show when={year()}>
            <span class="mc-chip mc-chip--year">{year()}</span>
          </Show>
          <Show when={language()}>
            <span class="mc-chip mc-chip--language">{language()}</span>
          </Show>
          <For each={genres()}>
            {(g) => <span class="mc-chip mc-chip--genre">{g}</span>}
          </For>
        </div>
      </div>
    </div>
  );
}
