import assert from "node:assert/strict";
import test from "node:test";
import { deckTag, expandTagTemplate } from "../src/anki/tags.ts";

test("deck tags keep the hierarchy and swap spaces for underscores", () => {
  assert.equal(deckTag(" Year 3 :: Nuclear  Physics "), "Year_3::Nuclear_Physics");
});

test("the template keeps a deck name literally, even with replacement patterns in it", () => {
  assert.deepEqual(expandTagTemplate("{deck}::Lecture_01 extra extra", "Costs $& more $1"), ["Costs_$&_more_$1::Lecture_01", "extra"]);
});
