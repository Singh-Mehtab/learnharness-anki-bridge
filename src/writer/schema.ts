// Result schema for the card writer (worker resultSchema). Plain JSON Schema,
// accepted by the host as a TSchema-compatible object, as core Flashcards does.

import { CORE_KINDS, type CardKind } from "./types.ts";

export function resultSchemaFor(kinds: readonly CardKind[] = CORE_KINDS) {
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
                  front: { type: "string", minLength: 1 },
                  back: { type: "string", minLength: 1 },
                  extra: { type: "string" },
                },
              },
            },
            skipReason: { type: "string", description: "Required when cards is empty: one sentence on why." },
          },
        },
      },
    },
  } as const;
}

export const resultSchema = resultSchemaFor();
