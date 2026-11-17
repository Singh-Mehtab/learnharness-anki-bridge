export type AnkiErrorKind =
  | "refused" | "timeout" | "not-anki-connect" | "key-rejected"
  | "api" | "transport" | "cancelled";

export class AnkiError extends Error {
  readonly kind: AnkiErrorKind;

  constructor(kind: AnkiErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AnkiError";
    this.kind = kind;
  }
}

export function normalizeUrl(value: string): string {
  const input = value.trim();
  // Reject syntax URL would silently discard, including empty query/fragment markers.
  if (!/^https?:\/\//i.test(input) || /[?#\\\s]/.test(input)) {
    throw new Error("Use an HTTP(S) root URL without a query or fragment.");
  }
  const url = new URL(input);
  const authority = input.slice(input.indexOf("://") + 3).split("/")[0]!;
  const path = input.slice(input.indexOf("://") + 3 + authority.length);
  if (authority.includes("@") || url.username || url.password || (path !== "" && path !== "/")) {
    throw new Error("Use an HTTP(S) root URL without credentials or a path.");
  }
  return url.href;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function noteId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validResult(action: string, result: unknown): boolean {
  switch (action) {
    case "version": return result === 6;
    case "getActiveProfile": return result === null || (typeof result === "string" && result.length > 0);
    case "deckNames": case "modelNames": case "modelFieldNames": return strings(result);
    case "modelStyling": return record(result) && typeof result.css === "string";
    case "modelTemplates": return record(result) && Object.values(result).every((template) =>
      record(template) && typeof template.Front === "string" && typeof template.Back === "string");
    case "addNote": case "createDeck": return noteId(result);
    case "findNotes": case "guiBrowse": return Array.isArray(result) && result.every(noteId);
    case "notesInfo": return Array.isArray(result) && result.every((note) =>
      record(note) && (Object.keys(note).length === 0 ||
        (noteId(note.noteId) && record(note.fields) && strings(note.tags) &&
          typeof note.modelName === "string" && Array.isArray(note.cards) && note.cards.every(noteId))));
    case "modelFieldAdd": case "updateModelStyling": case "updateModelTemplates": return result === null;
    case "createModel": return record(result) && typeof result.name === "string";
    default: return true;
  }
}

function refused(error: unknown): boolean {
  if (!record(error)) return false;
  return error.code === "ECONNREFUSED" ||
    (Array.isArray(error.errors) && error.errors.some(refused)) ||
    (error.cause !== undefined && refused(error.cause));
}

export class AnkiClient {
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: { url: string; apiKey?: string; timeoutMs?: number; signal?: AbortSignal }) {
    this.url = normalizeUrl(options.url);
    // AnkiConnect treats an explicit empty key as an authentication attempt.
    this.apiKey = options.apiKey === "" ? undefined : options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.signal = options.signal;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new Error("timeoutMs must be a positive finite timer interval.");
    }
  }

  async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.signal?.aborted) throw new AnkiError("cancelled", "AnkiConnect request cancelled.");
    const controller = new AbortController();
    let abortKind: "cancelled" | "timeout" | undefined;
    const cancel = () => {
      abortKind ??= "cancelled";
      controller.abort();
    };
    this.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      abortKind ??= "timeout";
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version: 6, params, ...(this.apiKey === undefined ? {} : { key: this.apiKey }) }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AnkiError("not-anki-connect", `AnkiConnect returned HTTP ${response.status}.`);
      }
      let envelope: unknown;
      try {
        envelope = await response.json();
      } catch (error) {
        if (abortKind) throw error;
        if (error instanceof SyntaxError) {
          throw new AnkiError("not-anki-connect", "Response is not AnkiConnect JSON.", { cause: error });
        }
        throw error;
      }
      if (!record(envelope) || !Object.hasOwn(envelope, "result") || !Object.hasOwn(envelope, "error") ||
          (envelope.error !== null && typeof envelope.error !== "string") ||
          (envelope.error !== null && envelope.result !== null)) {
        throw new AnkiError("not-anki-connect", "Response has no valid AnkiConnect v6 envelope.");
      }
      if (typeof envelope.error === "string") {
        const kind = /(?:invalid|missing|incorrect|reject|must|require).*(?:api.?key|key)|(?:api.?key|key).*(?:invalid|incorrect|reject|required|must|provided)/i.test(envelope.error)
          ? "key-rejected" : "api";
        const message = action === "getActiveProfile" && /unsupported action|unknown action|method not found/i.test(envelope.error)
          ? "This AnkiConnect build does not support getActiveProfile. Upgrade to a build with profile identity support; Anki Bridge will not send without it."
          : envelope.error;
        throw new AnkiError(kind, message);
      }
      if (!validResult(action, envelope.result)) {
        throw new AnkiError("not-anki-connect", `Invalid AnkiConnect result for ${action}.`);
      }
      return envelope.result as T;
    } catch (error) {
      if (abortKind) throw new AnkiError(abortKind, abortKind === "timeout" ? "AnkiConnect request timed out." : "AnkiConnect request cancelled.", { cause: error });
      if (error instanceof AnkiError) throw error;
      throw new AnkiError(refused(error) ? "refused" : "transport", "Could not complete the AnkiConnect request.", { cause: error });
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", cancel);
    }
  }

  async connection(): Promise<{ profile: string | null; decks: string[] }> {
    await this.call("version");
    const profile = await this.call<string | null>("getActiveProfile");
    if (profile === null) return { profile, decks: [] };
    const decks = await this.call<string[]>("deckNames");
    return { profile, decks };
  }
}
