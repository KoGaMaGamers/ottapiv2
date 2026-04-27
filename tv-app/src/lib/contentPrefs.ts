/**
 * Shared category-preference + adult-content helpers.
 *
 * Faithful port of `tv_app_v2/src/utils/contentPrefs.js`. Storage lives
 * in clientPreferences.ts (v3 schema bag); this module owns the filter
 * predicates and adult-content heuristics.
 */

import {
  type CategoryFilter,
  type ContentPrefsView,
  type ContentPrefs,
  getContentPreferences,
  setContentPreferences,
  getAdultContentPreferences,
  setAdultContentPreferences,
} from "./clientPreferences";

export { type CategoryFilter, type ContentPrefsView };

export const PREFS_KEY = "ott_content_prefs";

/** Read and parse the stored content preferences. */
export const getContentPrefs = (): ContentPrefsView => getContentPreferences();

/** Persist updated content preferences. */
export const setContentPrefs = (prefs: Partial<ContentPrefs>): void => {
  setContentPreferences(prefs);
};

/**
 * Filter an array of category/genre objects by a saved preference list.
 *
 * Behaviour:
 *   prefList === null         → return items unchanged (no restriction)
 *   prefList === []           → return [] (user explicitly deselected all)
 *   prefList has entries
 *     and some items match    → return matching items
 *     no items match          → return items unchanged (silent fallback —
 *                               donor-account ID mismatch resilience: avoids
 *                               a blank screen when OTTAPI now serves from
 *                               a donor whose category IDs differ from the
 *                               ones the user originally saved).
 */
export function filterByPrefs<T extends { id: string | number }>(
  items: T[],
  prefList: CategoryFilter,
): T[] {
  if (prefList === null) return items;
  if (prefList.length === 0) return [];

  const allowed = new Set(prefList.map(String));
  const filtered = items.filter((i) => allowed.has(String(i.id)));
  return filtered.length > 0 ? filtered : items;
}

// ---------------------------------------------------------------------------
// Adult content
// ---------------------------------------------------------------------------

/**
 * Pattern used to identify "adult" root live categories by name.
 * Matches common provider conventions: "For Adults", "Adults", "XXX",
 * "18+", etc.
 */
export const ADULT_PATTERN = /for\s*adults?|^adults?$|xxx|\b18\+/i;

export interface AdultProbeCategory {
  category_name?: string | null;
  name?: string | null;
}

/** Return true when a category object is considered adult-only. */
export function isAdultCategory(cat: AdultProbeCategory): boolean {
  return ADULT_PATTERN.test(cat.category_name || cat.name || "");
}

export const ADULT_PREFS_KEY = "ott_adult_prefs";
export const ADULT_CHANNEL_CATALOG_KEY = "ott_adult_channel_catalog";

/** Read stored adult channel preferences. */
export const getAdultPrefs = (): CategoryFilter => getAdultContentPreferences();

/** Persist updated adult channel preferences. */
export const setAdultPrefs = (prefs: CategoryFilter): void => {
  setAdultContentPreferences(prefs);
};

function normalizeAdultId(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Read known adult-channel IDs discovered from profile/live browsing.
 * Used to prevent adult channels from surfacing in generic
 * "recent/preferred" rails.
 */
export function getAdultChannelCatalog(): string[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(ADULT_CHANNEL_CATALOG_KEY) || "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeAdultId)
      .filter((s): s is string => s !== null);
  } catch {
    return [];
  }
}

/** Merge newly discovered adult stream IDs into the local catalog. */
export function rememberAdultChannelIds(ids: ReadonlyArray<unknown>): void {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const merged = new Set(getAdultChannelCatalog());
  for (const id of ids) {
    const normalized = normalizeAdultId(id);
    if (normalized) merged.add(normalized);
  }
  try {
    // Keep storage bounded while preserving recent discoveries.
    const compact = Array.from(merged).slice(-5000);
    localStorage.setItem(ADULT_CHANNEL_CATALOG_KEY, JSON.stringify(compact));
  } catch {
    // Silent fallback: filtering still works from current in-memory inputs.
  }
}

/** Build a Set for O(1) adult-channel ID checks across lists. */
export function buildAdultChannelIdSet(
  adultPrefs: CategoryFilter = getAdultPrefs(),
  adultCatalogIds: string[] = getAdultChannelCatalog(),
): Set<string> {
  const ids = new Set<string>();
  if (Array.isArray(adultPrefs)) {
    for (const id of adultPrefs) {
      const normalized = normalizeAdultId(id);
      if (normalized) ids.add(normalized);
    }
  }
  if (Array.isArray(adultCatalogIds)) {
    for (const id of adultCatalogIds) {
      const normalized = normalizeAdultId(id);
      if (normalized) ids.add(normalized);
    }
  }
  return ids;
}

export interface AdultProbeChannel {
  isAdult?: boolean;
  _isAdult?: boolean;
  adult?: boolean;
  category_name?: string | null;
  category?: string | null;
  group?: string | null;
  group_title?: string | null;
  groupName?: string | null;
  stream_id?: string | number | null;
  id?: string | number | null;
}

/**
 * Heuristic adult-channel detection for list surfaces:
 *   - explicit runtime flags (isAdult/adult)
 *   - category labels matching adult pattern
 *   - known adult channel IDs (prefs/catalog)
 */
export function isAdultChannel(
  channel: AdultProbeChannel | null | undefined,
  adultIdSet: Set<string> | null = null,
): boolean {
  if (!channel || typeof channel !== "object") return false;
  if (
    channel.isAdult === true ||
    channel._isAdult === true ||
    channel.adult === true
  ) {
    return true;
  }

  const categoryLabel =
    channel.category_name ||
    channel.category ||
    channel.group ||
    channel.group_title ||
    channel.groupName;
  if (categoryLabel && isAdultCategory({ category_name: categoryLabel })) {
    return true;
  }

  const channelId = normalizeAdultId(channel.stream_id ?? channel.id);
  return Boolean(
    channelId && adultIdSet instanceof Set && adultIdSet.has(channelId),
  );
}
