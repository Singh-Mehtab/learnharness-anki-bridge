// Learner-facing card-type copy shared by Write, Settings and Review (#38).
import type { CoreCardKind, StoredCardKind } from "./writer/types.ts";
import { el } from "./ui.ts";

/** Names for every stored kind, so legacy Recall and Compose cards stay readable. */
export const KIND_NAMES: Record<StoredCardKind, string> = {
  fact: "Fact", equation: "Equation", steps: "Steps", apply: "Apply", why: "Why", compose: "Compose", discriminate: "Contrast", recall: "Recall",
};

/** What each kind drafts, in one short sentence. */
export const KIND_HELP: Record<CoreCardKind, string> = {
  fact: "Remember a definition, unit, prefix or other fact.",
  equation: "Recall a formula or relation.",
  why: "Explain why a result holds.",
  steps: "Recall the next step in a method you carry out.",
  apply: "Pick the rule or method that fits a new situation.",
  discriminate: "Tell apart two ideas that are easy to mix up.",
};

/** Illustrative cards, not model output. Plain text, since this copy is not rendered as maths. */
export const KIND_EXAMPLES: Record<CoreCardKind, { front: string; back: string }> = {
  fact: { front: "What power of ten does the prefix femto- represent?", back: "10⁻¹⁵" },
  equation: { front: "What is a particle's rest energy in terms of its mass?", back: "E₀ = mc²" },
  why: { front: "Why do you need higher probe momentum to resolve smaller features?", back: "Smaller features need a shorter wavelength, and λ = h/p, so a shorter wavelength needs more momentum." },
  steps: { front: "Restoring SI units, you've matched the powers of ħ and c. What do you do next?", back: "Substitute their values in compatible units." },
  apply: { front: "You know an electron beam's momentum. Can it resolve a feature a few femtometres across? Which relation do you use first?", back: "The de Broglie relation, to get a wavelength to compare with the feature." },
  discriminate: { front: "A proton speeds up without changing its mass. Which part of its total energy increases?", back: "Its kinetic energy. Its rest energy stays the same." },
};

/** One example card: type, front and back. */
export function exampleCard(kind: CoreCardKind): HTMLElement {
  const card = el("div", undefined, "ab-kind-example");
  const { front, back } = KIND_EXAMPLES[kind];
  card.append(el("strong", KIND_NAMES[kind]), el("span", `Front: ${front}`), el("span", `Back: ${back}`));
  return card;
}
