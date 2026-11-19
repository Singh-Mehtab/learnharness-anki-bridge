// Anki tags for sent notes. Pure; shared by the frontend preview and delivery.

export const MAX_TAGS = 30;
export const MAX_TAG_LENGTH = 200;

/** Deck path as a tag: spaces become underscores, the :: hierarchy stays. */
export const deckTag = (deck: string): string =>
  deck.trim().split("::").map(part => part.trim().replace(/\s+/gu, "_")).filter(Boolean).join("::");

/** Space-separated template; {deck} becomes the deck path as a tag. */
export function expandTagTemplate(template: string, deck: string): string[] {
  const expanded = template.replace(/\{deck\}/giu, deckTag(deck));
  return [...new Set(expanded.split(/\s+/u).filter(Boolean))];
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
