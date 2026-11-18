import { createHash } from 'node:crypto';
import { failedOutputCallIds, teacherProse } from './flow.ts';
import type { MessageLike } from './flow.ts';

/** Fingerprint of one message as LearnHarness 0.6.1 records it in coverage.jsonl
 * (src/core/coverage.ts messageFingerprint: sha256 of JSON [role, view lines]).
 * This is a host detail, used only as a hint. If a future host changes it, no
 * fingerprint matches and flags simply stay "waiting for extraction"; they are
 * never dropped or marked done because of it. */
export function messageFingerprint(message: MessageLike, failed: ReadonlySet<string>): string {
  const lines = teacherProse(message, failed).map(t => `TEACHER [${String(message.id)}] ${t.trim()}`);
  return createHash('sha256').update(JSON.stringify([message.role, lines])).digest('hex');
}

/** Message IDs (of `ids`) whose current content the host has already extracted. */
export function extractedMessageIds(messages: readonly MessageLike[], covered: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const wanted = new Set(ids), failed = failedOutputCallIds(messages), out = new Set<string>();
  for (const m of messages) if (typeof m.id === 'string' && wanted.has(m.id) && covered.has(messageFingerprint(m, failed))) out.add(m.id);
  return out;
}
