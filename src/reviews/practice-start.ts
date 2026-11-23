// Starts a Practice session with picked graph nodes attached. This sends the same request
// LearnHarness's own Practice → Pick nodes sends (POST /api/chats, checked against 0.7.0).
// That request isn't part of the documented plugin API, so every failure says what to do
// instead, and the new session is read back before it opens.
export interface PracticePick { id: string; name: string; statement: string }

export const PRACTICE_FALLBACK = "Pick these ideas in Practice → Pick nodes instead.";
/** LearnHarness keeps at most 64 picked nodes when it starts a session. */
export const PRACTICE_LIMIT = 64;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function practiceTitle(picks: readonly PracticePick[]): string {
  return `Practice: ${picks.map(p => p.name.trim() || "Idea").join(", ")}`;
}

/** Returns the new session's ID. Throws a message fit to show the learner. */
export async function startPracticeSession(picks: readonly PracticePick[], fetchLike: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<string> {
  const propositions = picks.map(({ id, name, statement }) => ({ id, name, statement }));
  let response: Response;
  try {
    response = await fetchLike("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: practiceTitle(picks), kind: "practice", graphContext: { propositions } }),
    });
  } catch {
    throw new Error(`Couldn't reach LearnHarness to start a Practice session. ${PRACTICE_FALLBACK}`);
  }
  if (!response.ok) {
    throw new Error(`LearnHarness didn't start the Practice session (HTTP ${response.status}). This LearnHarness version may not support starting Practice from Anki Bridge. ${PRACTICE_FALLBACK}`);
  }
  const created: unknown = await response.json().catch(() => null);
  const id = typeof created === "object" && created !== null ? (created as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw new Error(`LearnHarness answered in an unexpected way. ${PRACTICE_FALLBACK}`);
  // A future LearnHarness could accept the request but ignore the kind or the picks.
  // Read the session back so the learner never lands in a session without their ideas.
  let attached = false;
  try {
    const saved = await fetchLike(`/api/chats/${id}`, { cache: "no-store" });
    const record = saved.ok ? await saved.json() as { kind?: unknown; messages?: unknown } : null;
    const first = Array.isArray(record?.messages) ? record.messages[0] as { customType?: unknown; details?: { propositions?: unknown } } | undefined : undefined;
    const savedIds = Array.isArray(first?.details?.propositions) ? (first.details.propositions as { id?: unknown }[]).map(p => p?.id) : [];
    attached = record?.kind === "practice" && first?.customType === "graph-context"
      && savedIds.length === propositions.length && propositions.every((p, i) => savedIds[i] === p.id);
  } catch { attached = false; }
  if (!attached) {
    throw new Error(`LearnHarness created a session called "${practiceTitle(picks)}" but didn't attach the selected ideas, so Bridge didn't open it. You can delete it from the sidebar. ${PRACTICE_FALLBACK}`);
  }
  return id;
}
