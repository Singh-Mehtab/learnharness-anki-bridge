// FI-8: write a synthetic .apkg with basic and cloze cards, for import checks
// with Anki's library (bench/cloze-apkg-check.py) or a throwaway profile.
//   node bench/cloze-apkg.ts out.apkg
import { writeFileSync } from 'node:fs';
import { exportPackage } from '../src/anki/apkg.ts';
import { initialState } from '../src/anki/state.ts';
import type { Card } from '../src/anki/state.ts';

const base = { status: 'approved' as const, statementHash: 'h', sessionId: 's', nodeName: 'Synthetic idea', sessionName: 'Synthetic lecture', kind: 'fact' as const, extra: '' };
const cards: Card[] = [
  { ...base, id: '0b6f7c1e-0000-4000-8000-0000000000a1', nodeId: 'n1', front: 'What is \\(\\hbar c\\) in MeV fm?', back: '\\(197.3\\)' },
  { ...base, id: '0b6f7c1e-0000-4000-8000-0000000000a2', nodeId: 'n2', format: 'cloze', front: 'In SI units, \\([\\hbar] = {{blank}}\\)', back: '\\mathrm{J\\,s}', extra: 'Same units as angular momentum.' },
  { ...base, id: '0b6f7c1e-0000-4000-8000-0000000000a3', nodeId: 'n3', format: 'cloze', front: 'The prefix femto- (f) means {{blank}}.', back: '\\(10^{-15}\\)' },
  { ...base, id: '0b6f7c1e-0000-4000-8000-0000000000a4', nodeId: 'n4', kind: 'equation', format: 'cloze', front: 'Relativistic momentum: \\(\\vec{p} = {{blank}}\\)', back: '\\gamma m \\vec{v}' },
];
const state = { ...initialState(), cards };
const result = await exportPackage(state, { ids: cards.map(c => c.id), deck: 'FI-8 check', tags: [] });
writeFileSync(process.argv[2]!, Buffer.from(result.data, 'base64'));
console.log(`${cards.length} cards -> ${process.argv[2]}`);
