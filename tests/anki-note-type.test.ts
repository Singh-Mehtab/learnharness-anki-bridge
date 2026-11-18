import { test } from "node:test";
import assert from "node:assert/strict";
import { AnkiClient, AnkiError } from "../src/anki/client.ts";
import { ensureNoteType, repairFields, updateStyling, FIELDS, MARKER, MODEL_NAME, STYLE_REVISION } from "../src/anki/note-type.ts";

class FakeAnki extends AnkiClient {
  exists = true;
  css = MARKER + " user edits";
  fields: string[] = [...FIELDS];
  templates: Record<string, { Front: string; Back: string }> = { "Card 1": { Front: "user front", Back: "user back" } };
  calls: { action: string; params: Record<string, unknown> }[] = [];
  constructor() { super({ url: "http://fake.invalid" }); }
  override async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ action, params });
    let result: unknown = null;
    switch (action) {
      case "modelNames": result = this.exists ? [MODEL_NAME] : []; break;
      case "createModel": {
        this.exists = true;
        this.css = params.css as string;
        this.fields = [...params.inOrderFields as string[]];
        const template = (params.cardTemplates as { Name: string; Front: string; Back: string }[])[0]!;
        this.templates = { [template.Name]: { Front: template.Front, Back: template.Back } };
        result = { name: MODEL_NAME };
        break;
      }
      case "modelStyling": result = { css: this.css }; break;
      case "modelFieldNames": result = [...this.fields]; break;
      case "modelTemplates": result = this.templates; break;
      case "modelFieldAdd": this.fields.push(params.fieldName as string); break;
      case "updateModelStyling": this.css = (params.model as { css: string }).css; break;
      case "updateModelTemplates": this.templates = (params.model as { templates: Record<string, { Front: string; Back: string }> }).templates; break;
      default: throw new Error(`Unexpected action ${action}`);
    }
    return result as T;
  }
}

const apiError = (error: unknown) => error instanceof AnkiError && error.kind === "api";
const mutations = (client: FakeAnki) => client.calls.filter(({ action }) => /^(create|update)|modelFieldAdd/.test(action));

test("ensureNoteType creates one owned model and verifies ownership and fields every time", async () => {
  const client = new FakeAnki();
  client.exists = false;
  await ensureNoteType(client);
  assert.deepEqual(client.fields, FIELDS);
  assert.ok(client.css.includes(MARKER));
  assert.equal(mutations(client).length, 1);
  const back = client.templates["Card 1"]!.Back;
  assert.match(back, /lh-source.*\{\{Source\}\}/);
  assert.match(back, /\{\{Extra\}\}/);
  assert.doesNotMatch(JSON.stringify(client.templates), /LH_ID|LH_Node/);
  client.calls = [];
  await ensureNoteType(client);
  assert.deepEqual(client.calls.map(({ action }) => action), ["modelNames", "modelStyling", "modelFieldNames"]);
  assert.equal(mutations(client).length, 0);
});

test("existing user styling/templates stay unchanged; unmarked model cannot be reused or mutated", async () => {
  const client = new FakeAnki();
  await ensureNoteType(client);
  assert.equal(client.css, MARKER + " user edits");
  assert.equal(client.templates["Card 1"]!.Front, "user front");
  client.css = "unowned";
  for (const operation of [ensureNoteType, repairFields, updateStyling]) {
    await assert.rejects(operation(client), apiError);
  }
  assert.equal(mutations(client).length, 0);
});

test("all rendered and delivery fields are required; explicit repair only adds missing fields", async () => {
  for (const field of FIELDS.slice(1)) {
    const client = new FakeAnki();
    client.fields = client.fields.filter((name) => name !== field);
    await assert.rejects(ensureNoteType(client), new RegExp(field));
    assert.equal(mutations(client).length, 0);
    await repairFields(client);
    assert.deepEqual(mutations(client), [{ action: "modelFieldAdd", params: { modelName: MODEL_NAME, fieldName: field } }]);
    assert.equal(client.css, MARKER + " user edits");
    assert.equal(client.templates["Card 1"]!.Front, "user front");
    await ensureNoteType(client);
  }
});

test("missing or reordered Front is never automatically added or reordered", async () => {
  for (const fields of [[...FIELDS.slice(1)], ["Back", "Front", ...FIELDS.slice(2)]]) {
    const client = new FakeAnki();
    client.fields = fields;
    for (const operation of [ensureNoteType, repairFields, updateStyling]) await assert.rejects(operation(client), /first field/);
    assert.equal(mutations(client).length, 0);
  }
});

test("explicit update replaces edited Card 1 content only after ownership and field checks", async () => {
  const client = new FakeAnki();
  client.css = "/* learnharness-anki v1 */ user style";
  await ensureNoteType(client); // A 0.6.0 note type does not need a styling update to send.
  assert.equal(mutations(client).length, 0);
  client.calls = [];
  await updateStyling(client);
  assert.deepEqual(client.calls.map(({ action }) => action), ["modelStyling", "modelFieldNames", "modelTemplates", "updateModelStyling", "updateModelTemplates"]);
  assert.ok(client.css.includes(MARKER));
  assert.ok(client.css.includes(STYLE_REVISION));
  assert.equal(client.templates["Card 1"]!.Front, "{{Front}}");
  assert.match(client.templates["Card 1"]!.Back, /\{\{Source\}\}/);
  client.calls = [];
  client.fields = client.fields.filter((field) => field !== "Extra");
  await assert.rejects(updateStyling(client), /missing fields/);
  assert.equal(mutations(client).length, 0);
});

test("explicit update refuses extra/reverse or renamed templates without mutation", async () => {
  const templateSets: Record<string, { Front: string; Back: string }>[] = [
    { "Card 1": { Front: "front", Back: "back" }, Reverse: { Front: "back", Back: "front" } },
    { Renamed: { Front: "front", Back: "back" } },
  ];
  for (const templates of templateSets) {
    const client = new FakeAnki();
    client.templates = templates;
    await assert.rejects(updateStyling(client), /exactly one template/);
    assert.equal(mutations(client).length, 0);
  }
});
