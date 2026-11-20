import { AnkiClient, AnkiError } from "./client.ts";

export const MODEL_NAME = "LearnHarness Basic";
export const FIELDS = ["Front", "Back", "Extra", "Source", "LH_ID", "LH_Node"] as const;
export const MARKER = "/* learnharness-anki owned */";
export const STYLE_REVISION = "/* learnharness-anki style v1 */";
const LEGACY_MARKER = "/* learnharness-anki v1 */";

// Keep the old marker as an alias so rolling back to 0.6.0 can still send.
// The .apkg export (apkg.ts) reuses the CSS and templates so both routes carry the same note type.
export const CSS = `${MARKER}
${STYLE_REVISION}
${LEGACY_MARKER}
.card { font-family: sans-serif; font-size: 20px; text-align: left; }
.lh-extra { margin-top: 1em; }
.lh-source { margin-top: 1em; font-size: 0.75em; opacity: 0.7; }
pre { white-space: pre-wrap; tab-size: 4; }
code { font-family: monospace; }
`;
export const FRONT = "{{Front}}";
export const BACK = `{{FrontSide}}
<hr id="answer">
{{Back}}
{{#Extra}}<div class="lh-extra">{{Extra}}</div>{{/Extra}}
{{#Source}}<div class="lh-source">{{Source}}</div>{{/Source}}`;
export const TEMPLATE_NAME = "Card 1";

function fail(message: string): never {
  throw new AnkiError("api", message);
}

async function inspect(client: AnkiClient): Promise<string[]> {
  const styling = await client.call<{ css: string }>("modelStyling", { modelName: MODEL_NAME });
  const fields = await client.call<string[]>("modelFieldNames", { modelName: MODEL_NAME });
  if (!styling.css.includes(MARKER) && !styling.css.includes(LEGACY_MARKER)) {
    fail(`The note type "${MODEL_NAME}" is not owned by Anki Bridge (CSS marker missing). Rename it in Anki before continuing.`);
  }
  return fields;
}

function checkFields(fields: string[]): void {
  if (fields[0] !== "Front") fail(`"${MODEL_NAME}" must have Front as its first field. Fix the field order in Anki; Anki Bridge will not reorder it.`);
  const missing = FIELDS.filter((field) => !fields.includes(field));
  if (missing.length) fail(`"${MODEL_NAME}" is missing fields: ${missing.join(", ")}. Use Add missing fields to repair it.`);
}

export async function ensureNoteType(client: AnkiClient): Promise<void> {
  const names = await client.call<string[]>("modelNames");
  if (!names.includes(MODEL_NAME)) {
    await client.call("createModel", {
      modelName: MODEL_NAME,
      inOrderFields: [...FIELDS],
      css: CSS,
      isCloze: false,
      cardTemplates: [{ Name: TEMPLATE_NAME, Front: FRONT, Back: BACK }],
    });
  }
  checkFields(await inspect(client));
}

export async function repairFields(client: AnkiClient): Promise<void> {
  const fields = await inspect(client);
  // Adding Front at the end cannot repair the duplicate-check field safely.
  if (fields[0] !== "Front") checkFields(fields);
  for (const field of FIELDS) {
    if (!fields.includes(field)) {
      await client.call("modelFieldAdd", { modelName: MODEL_NAME, fieldName: field });
    }
  }
  checkFields(await inspect(client));
}

export async function updateStyling(client: AnkiClient): Promise<void> {
  checkFields(await inspect(client));
  // AnkiConnect updates named templates; it cannot rename or remove extra ones.
  // Refuse an altered template set rather than silently leaving reverse cards behind.
  const templates = await client.call<Record<string, { Front: string; Back: string }>>("modelTemplates", { modelName: MODEL_NAME });
  if (Object.keys(templates).length !== 1 || !Object.hasOwn(templates, TEMPLATE_NAME)) {
    fail(`"${MODEL_NAME}" must have exactly one template named "${TEMPLATE_NAME}" before styling can be updated. Fix its templates in Anki first.`);
  }
  await client.call("updateModelStyling", { model: { name: MODEL_NAME, css: CSS } });
  await client.call("updateModelTemplates", {
    model: { name: MODEL_NAME, templates: { [TEMPLATE_NAME]: { Front: FRONT, Back: BACK } } },
  });
}
