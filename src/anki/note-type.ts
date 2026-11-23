import { AnkiClient, AnkiError } from "./client.ts";

export const MODEL_NAME = "LearnHarness Basic";
export const FIELDS = ["Front", "Back", "Extra", "Source", "LH_ID", "LH_Node"] as const;
export const MARKER = "/* learnharness-anki owned */";
export const STYLE_REVISION = "/* learnharness-anki style v1 */";
const LEGACY_MARKER = "/* learnharness-anki v1 */";

const BASE_CSS = `.card { font-family: sans-serif; font-size: 20px; text-align: left; }
.lh-extra { margin-top: 1em; }
.lh-source { margin-top: 1em; font-size: 0.75em; opacity: 0.7; }
pre { white-space: pre-wrap; tab-size: 4; }
code { font-family: monospace; }
`;

// Keep the old marker as an alias so rolling back to 0.6.0 can still send.
// The .apkg export (apkg.ts) reuses the CSS and templates so both routes carry the same note type.
export const CSS = `${MARKER}
${STYLE_REVISION}
${LEGACY_MARKER}
${BASE_CSS}`;
export const FRONT = "{{Front}}";
export const BACK = `{{FrontSide}}
<hr id="answer">
{{Back}}
{{#Extra}}<div class="lh-extra">{{Extra}}</div>{{/Extra}}
{{#Source}}<div class="lh-source">{{Source}}</div>{{/Source}}`;
export const TEMPLATE_NAME = "Card 1";

/** An Anki note type the plugin owns. */
export interface NoteTypeSpec {
  /** Short key used in operations and confirmations. */
  key: "basic" | "cloze";
  name: string;
  fields: readonly string[];
  css: string;
  front: string;
  back: string;
  templateName: string;
  isCloze: boolean;
}

export const BASIC_NOTE_TYPE: NoteTypeSpec = { key: "basic", name: MODEL_NAME, fields: FIELDS, css: CSS, front: FRONT, back: BACK, templateName: TEMPLATE_NAME, isCloze: false };

// FI-8: one blank per note (c1), so one card. Same ownership marker, its own style revision.
export const CLOZE_MODEL_NAME = "LearnHarness Cloze";
export const CLOZE_FIELDS = ["Text", "Extra", "Source", "LH_ID", "LH_Node"] as const;
export const CLOZE_STYLE_REVISION = "/* learnharness-anki cloze style v1 */";
export const CLOZE_CSS = `${MARKER}
${CLOZE_STYLE_REVISION}
${BASE_CSS}.cloze { font-weight: bold; color: #1565c0; }
.nightMode .cloze { color: #90caf9; }
`;
export const CLOZE_FRONT = "{{cloze:Text}}";
export const CLOZE_BACK = `{{cloze:Text}}
{{#Extra}}<div class="lh-extra">{{Extra}}</div>{{/Extra}}
{{#Source}}<div class="lh-source">{{Source}}</div>{{/Source}}`;
export const CLOZE_TEMPLATE_NAME = "Cloze";
export const CLOZE_NOTE_TYPE: NoteTypeSpec = { key: "cloze", name: CLOZE_MODEL_NAME, fields: CLOZE_FIELDS, css: CLOZE_CSS, front: CLOZE_FRONT, back: CLOZE_BACK, templateName: CLOZE_TEMPLATE_NAME, isCloze: true };

export const noteTypeFor = (card: { format?: string }): NoteTypeSpec => card.format === "cloze" ? CLOZE_NOTE_TYPE : BASIC_NOTE_TYPE;
/** Settings repair actions name the note type; older callers send none and mean basic. */
export function noteTypeInput(value: unknown): NoteTypeSpec {
  if (value === undefined || value === "basic") return BASIC_NOTE_TYPE;
  if (value === "cloze") return CLOZE_NOTE_TYPE;
  throw new Error("Unknown note type.");
}

interface NativeModel { type: 0 | 1; css?: string }

/** Anki's model names are editable. Only the native `type` distinguishes Cloze. */
export async function readNativeModels(client: Pick<AnkiClient, 'call'>, names: string[]): Promise<Map<string, NativeModel>> {
  const types = new Map<string, NativeModel>();
  if (!names.length) return types;
  const models = await client.call<unknown>('findModelsByName', { modelNames: names });
  if (!Array.isArray(models)) return types;
  for (const entry of models) {
    if (!entry || !names.includes(entry.name) || (entry.type !== 0 && entry.type !== 1) || types.has(entry.name)) return new Map();
    types.set(entry.name, { type: entry.type, ...(typeof entry.css === 'string' ? { css: entry.css } : {}) });
  }
  return types;
}

export const nativeTypeMatches = (model: NativeModel | undefined, spec: NoteTypeSpec): boolean => model?.type === (spec.isCloze ? 1 : 0);
const ownsStyle = (css: string, spec: NoteTypeSpec): boolean => css.includes(MARKER) || (spec.key === 'basic' && css.includes(LEGACY_MARKER));
export const hasOwnedStyle = (model: NativeModel | undefined, spec: NoteTypeSpec): boolean => ownsStyle(model?.css ?? '', spec);

function fail(message: string): never {
  throw new AnkiError("api", message);
}

async function inspect(client: AnkiClient, spec: NoteTypeSpec): Promise<string[]> {
  const styling = await client.call<{ css: string }>("modelStyling", { modelName: spec.name });
  const fields = await client.call<string[]>("modelFieldNames", { modelName: spec.name });
  if (!ownsStyle(styling.css, spec)) {
    fail(`The note type "${spec.name}" is not owned by Anki Bridge (CSS marker missing). Rename it in Anki before continuing.`);
  }
  const native = (await readNativeModels(client, [spec.name])).get(spec.name);
  if (!nativeTypeMatches(native, spec)) fail(`Cannot verify that "${spec.name}" has the expected Anki note type.`);
  return fields;
}

function checkFields(spec: NoteTypeSpec, fields: string[]): void {
  const first = spec.fields[0];
  if (fields[0] !== first) fail(`"${spec.name}" must have ${first} as its first field. Fix the field order in Anki; Anki Bridge will not reorder it.`);
  const missing = spec.fields.filter((field) => !fields.includes(field));
  if (missing.length) fail(`"${spec.name}" is missing fields: ${missing.join(", ")}. Use Add missing fields to repair it.`);
}

export async function ensureNoteType(client: AnkiClient, spec: NoteTypeSpec = BASIC_NOTE_TYPE): Promise<void> {
  const names = await client.call<string[]>("modelNames");
  if (!names.includes(spec.name)) {
    await client.call("createModel", {
      modelName: spec.name,
      inOrderFields: [...spec.fields],
      css: spec.css,
      isCloze: spec.isCloze,
      cardTemplates: [{ Name: spec.templateName, Front: spec.front, Back: spec.back }],
    });
  }
  checkFields(spec, await inspect(client, spec));
}

export async function repairFields(client: AnkiClient, spec: NoteTypeSpec = BASIC_NOTE_TYPE): Promise<void> {
  const fields = await inspect(client, spec);
  // Adding the first field at the end cannot repair the duplicate-check field safely.
  if (fields[0] !== spec.fields[0]) checkFields(spec, fields);
  for (const field of spec.fields) {
    if (!fields.includes(field)) {
      await client.call("modelFieldAdd", { modelName: spec.name, fieldName: field });
    }
  }
  checkFields(spec, await inspect(client, spec));
}

export async function updateStyling(client: AnkiClient, spec: NoteTypeSpec = BASIC_NOTE_TYPE): Promise<void> {
  checkFields(spec, await inspect(client, spec));
  // AnkiConnect updates named templates; it cannot rename or remove extra ones.
  // Refuse an altered template set rather than silently leaving reverse cards behind.
  const templates = await client.call<Record<string, { Front: string; Back: string }>>("modelTemplates", { modelName: spec.name });
  if (Object.keys(templates).length !== 1 || !Object.hasOwn(templates, spec.templateName)) {
    fail(`"${spec.name}" must have exactly one template named "${spec.templateName}" before styling can be updated. Fix its templates in Anki first.`);
  }
  await client.call("updateModelStyling", { model: { name: spec.name, css: spec.css } });
  await client.call("updateModelTemplates", {
    model: { name: spec.name, templates: { [spec.templateName]: { Front: spec.front, Back: spec.back } } },
  });
}
