import assert from "node:assert/strict";
import test from "node:test";
import { deckTag, expandTagTemplate, matchTagCase, MAX_TAG_SUGGESTIONS, tagSuggestions } from "../src/anki/tags.ts";

test("deck tags keep the hierarchy and swap spaces for underscores", () => {
  assert.equal(deckTag(" Year 3 :: Nuclear  Physics "), "Year_3::Nuclear_Physics");
});

test("the template keeps a deck name literally, even with replacement patterns in it", () => {
  assert.deepEqual(expandTagTemplate("{deck}::Lecture_01 extra extra", "Costs $& more $1"), ["Costs_$&_more_$1::Lecture_01", "extra"]);
});

test("a tag takes the casing the collection already uses, level by level (#28)", () => {
  const known = ["YEAR_3::Theoretical_Physics_3::Lecture_01", "YEAR_3::Foundation_of_Physics_3A::NPP1::Lecture_02", "learnharness"];
  assert.equal(matchTagCase("Year_3::Foundation_of_Physics_3A::NPP1::Lecture_03", known), "YEAR_3::Foundation_of_Physics_3A::NPP1::Lecture_03");
  assert.equal(matchTagCase("Year_3::Quantum_3::Lecture_01", known), "YEAR_3::Quantum_3::Lecture_01");
  assert.equal(matchTagCase("Other::Tag", known), "Other::Tag");
  assert.equal(matchTagCase("Year_3::Foundation_of_Physics_3A", []), "Year_3::Foundation_of_Physics_3A");
});

test("tag suggestions complete the last word and keep the words before it (#31)", () => {
  const known = ["YEAR_3::NPP1::Lecture_10", "YEAR_3::NPP1::Lecture_02", "YEAR_3::QM3", "physics", "Physics_Lab"];
  assert.deepEqual(tagSuggestions("year_3::npp1", known), ["YEAR_3::NPP1::Lecture_02", "YEAR_3::NPP1::Lecture_10"]);
  assert.deepEqual(tagSuggestions("extra phy", known), ["extra physics", "extra Physics_Lab"]);
  // Tags already in the field are not offered again.
  assert.deepEqual(tagSuggestions("physics phy", known), ["physics Physics_Lab"]);
});

test("an empty last word suggests only tags under the deck, never the whole collection", () => {
  const known = ["YEAR_3::NPP1::Lecture_01", "YEAR_3::NPP1", "YEAR_3::QM3", "physics"];
  assert.deepEqual(tagSuggestions("", known, "Year 3::NPP1"), ["YEAR_3::NPP1", "YEAR_3::NPP1::Lecture_01"]);
  assert.deepEqual(tagSuggestions("YEAR_3::NPP1 ", known, "Year 3::NPP1"), ["YEAR_3::NPP1 YEAR_3::NPP1::Lecture_01"]);
  assert.deepEqual(tagSuggestions("", known), []);
  const many = Array.from({ length: 100 }, (_, i) => `t${i}`);
  assert.equal(tagSuggestions("t", many).length, MAX_TAG_SUGGESTIONS);
});
