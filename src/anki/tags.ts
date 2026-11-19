// Anki tags for sent notes. Pure; shared by the frontend preview and delivery.

export const MAX_TAGS = 30;
export const MAX_TAG_LENGTH = 200;

/** Deck path as a tag: spaces become underscores, the :: hierarchy stays. */
export const deckTag = (deck: string): string =>
  deck.trim().split("::").map(part => part.trim().replace(/\s+/gu, "_")).filter(Boolean).join("::");

/** Space-separated template; {deck} becomes the deck path as a tag. */
export function expandTagTemplate(template: string, deck: string): string[] {
  const expanded = template.replace(/\{deck\}/giu, () => deckTag(deck));
  return [...new Set(expanded.split(/\s+/u).filter(Boolean))];
}

/** Gives a tag the casing already used in the collection, level by level.
 * With YEAR_3::Theoretical_Physics_3 in Anki, Year_3::NPP1 becomes YEAR_3::NPP1. */
export function matchTagCase(tag: string, known: readonly string[]): string {
  const cased = new Map<string, string>();
  for (const name of known) {
    const parts = name.split("::");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("::");
      if (!cased.has(prefix.toLocaleLowerCase())) cased.set(prefix.toLocaleLowerCase(), prefix);
    }
  }
  const parts = tag.split("::");
  for (let i = parts.length; i > 0; i--) {
    const match = cased.get(parts.slice(0, i).join("::").toLocaleLowerCase());
    if (match) return [match, ...parts.slice(i)].join("::");
  }
  return tag;
}

export const MAX_TAG_SUGGESTIONS = 30;

/** Completions for the last word of a space-separated tag field, each the whole field value.
 * The browser's suggestion list matches by prefix, so each option starts with what is typed.
 * An empty last word suggests only tags under the deck's tag, never the whole collection. */
export function tagSuggestions(value: string, known: readonly string[], deck = ""): string[] {
  const start = value.search(/\S+$/u);
  const head = start < 0 ? value : value.slice(0, start), word = start < 0 ? "" : value.slice(start);
  const used = new Set(head.split(/\s+/u).filter(Boolean).map(t => t.toLocaleLowerCase()));
  const lower = word.toLocaleLowerCase(), base = deckTag(deck).toLocaleLowerCase();
  const fits = (tag: string) => {
    const t = tag.toLocaleLowerCase();
    if (used.has(t) || t === lower) return false;
    return word ? t.startsWith(lower) : !!base && (t === base || t.startsWith(`${base}::`));
  };
  return known.filter(fits).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, MAX_TAG_SUGGESTIONS).map(tag => `${head}${tag}`);
}

/** Throws a learner-facing message for a tag Anki would split or reject. */
export function validateTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(tag => typeof tag !== "string")) throw new Error("Tags must be a list of text values.");
  const tags = [...new Set((value as string[]).map(tag => tag.trim()).filter(Boolean))];
  if (tags.length > MAX_TAGS) throw new Error(`Use at most ${MAX_TAGS} tags.`);
  for (const tag of tags) {
    if (/\s/u.test(tag)) throw new Error(`Tag "${tag}" contains a space. Use underscores inside a tag.`);
    if (tag.length > MAX_TAG_LENGTH || tag.includes("\0")) throw new Error("A tag is too long or contains a null character.");
  }
  return tags;
}

export const systemTags = (kind: string): string[] => ["learnharness", `learnharness::kind::${kind}`];
