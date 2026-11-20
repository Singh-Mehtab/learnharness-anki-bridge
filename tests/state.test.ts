import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncDirectory } from '../src/anki/state.ts';

test('directory sync is skipped on Windows, where fsync on a directory fails with EPERM', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'anki-bridge-sync-'));
  try {
    const missing = path.join(root, 'missing');
    // A missing directory proves whether the handle is opened at all.
    await syncDirectory(missing, 'win32');
    await assert.rejects(syncDirectory(missing, 'linux'), { code: 'ENOENT' });
    await syncDirectory(root, 'darwin');
  } finally { await rm(root, { recursive: true, force: true }); }
});
