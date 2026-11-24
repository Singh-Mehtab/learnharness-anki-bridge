// Result schema for the card writer (worker resultSchema). Plain JSON Schema,
// accepted by the host as a TSchema-compatible object, as core Flashcards does.

import { CORE_KINDS, type CardKind } from "./types.ts";

/** cloze: the FI-8 cloze writer's schema, whose cards may carry a format.
 *  Without it the schema is exactly the basic writer's. */
export function resultSchemaFor(kinds: readonly CardKind[] = CORE_KINDS, options: { cloze?: boolean; earlierRepeats?: boolean } = {}) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["targets"],
    properties: {
      targets: {
        type: "array",
        description: "Every target from the input, exactly once.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["nodeId", "cards"],
          properties: {
            nodeId: { type: "string", minLength: 1, description: "The target's nodeId, verbatim." },
            cards: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "front", "back"],
                properties: {
                  kind: { type: "string", enum: [...kinds] },
                  ...(options.cloze ? { format: { type: "string", enum: ["basic", "cloze"], description: "Omit or basic for a question card; cloze for a statement whose front holds {{blank}}." } } : {}),
                  front: { type: "string", minLength: 1 },
                  back: { type: "string", minLength: 1 },
                  extra: { type: "string" },
                  ...(options.earlierRepeats ? { possibleRepeatOf: { type: "string", minLength: 1, description: "ID of a card in this target's earlierRepeatCandidates, if this draft might repeat it." } } : {}),
                },
              },
            },
            flagMatches: { type: "array", items: { type: "string" }, description: "IDs of reply notes that a card on this target directly answers; omit if none." },
            skipReason: { type: "string", description: "Required when cards is empty: one sentence on why." },
            ...(options.earlierRepeats ? { earlierRepeatOf: { type: "string", minLength: 1, description: "ID of a card in this target's earlierRepeatCandidates that covers the undrafted recall task; only with no cards and without writeAnyway." } } : {}),
          },
        },
      },
    },
  } as const;
}

export const resultSchema = resultSchemaFor();
