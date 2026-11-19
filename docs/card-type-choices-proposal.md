# Fewer card-type choices on Write

Proposal for [#38](https://github.com/Singh-Mehtab/learnharness-anki-bridge/issues/38). The Write page shows seven checkboxes before the learner drafts anything. Keep the checkboxes, but show the ones people are most likely to change for a given lesson. Keep the current names so the controls, examples, and review labels match.

## Starting proposal

| Rank | Type | Proposed placement | What it tests |
| --- | --- | --- | --- |
| 1 | **Fact** | Write, checked by default | Recall a definition, unit, prefix, or other fact. |
| 2 | **Equation** | Write, checked by default | Recall a formula or relation. |
| 3 | **Why** | Write, unchecked by default | Explain why a result holds. |
| 4 | **Steps** | Write, unchecked by default | Recall the first or next step in a repeatable method. |
| 5 | **Apply** | Settings, off by default | Pick the rule or method that fits a new situation. |
| 6 | **Compose** | Remove from new drafting choices | Given the pieces of a reasoning chain, say what follows. |
| 7 | **Contrast** | Settings, off by default | Tell apart two ideas that are easy to mix up. |

Give each visible checkbox a short description. Add a single **See examples** disclosure on Write, and put examples for Apply and Contrast next to their controls in Settings. If either Settings-only type is active, show that in the Write summary so the learner can see what the writer may produce.

Why earns a spot because it asks for the reasoning behind a result. Steps is useful for methods learners regularly carry out, even when most lectures do not need it. Apply is useful when a learner knows the rules but has trouble choosing one; try it in Settings before giving it a permanent spot. Compose often tests the same lesson as Why in reverse. Removing it from new drafting should leave existing cards and generation history readable. Contrast is worth keeping for genuine mix-ups, but it need not be on Write.

## Example cards

These are illustrative physics examples, not exported cards or model results.

| Type | Front | Back |
| --- | --- | --- |
| Fact | What power of ten does the SI prefix *femto* represent? | $10^{-15}$. |
| Equation | What is a particle's rest energy in terms of its mass? | $E_0 = mc^2$. |
| Why | Why do you need higher probe momentum to resolve smaller features? | Smaller features require a shorter wavelength, and $\lambda = h/p$ means a shorter wavelength requires higher momentum. |
| Steps | When restoring SI units, you've matched the powers of $\hbar$ and $c$. What do you do next? | Substitute their numerical values in compatible units. |
| Apply | You know an electron beam's momentum and want to check whether it can resolve a feature a few femtometres across. Which relation do you use first? | The de Broglie relation. It gives you a wavelength to compare with the size of the feature. |
| Compose | A probe can resolve features only down to about its wavelength, and $\lambda = h/p$. What must change about the momentum to resolve finer detail? | The momentum must increase. |
| Contrast | A proton speeds up without changing its mass. Which part of its total energy increases? | Its kinetic energy. Its rest energy stays the same. |

## Questions for the next round

- Compare four checkboxes with a five-checkbox layout that adds Apply. Would you reach for Apply often enough to keep it visible? If four is the limit, would you use Apply more often than Steps?
- Look for Compose examples that test something worth reviewing separately from Why. If the distinction matters in practice, keep Compose in Settings instead of removing it from new drafting choices.
- Check whether the short descriptions are enough to pick a type without opening the examples. Use front-and-back examples for the labels people still confuse.

This PR records the proposal only. It does not change the plugin, prompt, saved data, or version. The numerical constants control ([#37](https://github.com/Singh-Mehtab/learnharness-anki-bridge/issues/37)) is separate.
