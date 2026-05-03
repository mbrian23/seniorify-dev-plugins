// T028 — non-trivial classification of the layered threshold evaluator
// (research.md §2). Covers the three signals that flip a write off the
// "trivial" path: ≥5-line edits, public-surface touches, dependency adds.
//
// Pure unit test — no I/O, deterministic, side-effect-free.

import { describe, expect, it } from 'vitest';

import { evaluate } from '../../src/threshold/evaluator.js';
import { extractSignal } from '../../src/threshold/signals.js';

import type { Aggressiveness } from '../../src/backend/schemas/engagement-event.js';

const e = (file_path: string, oldStr: string, newStr: string) =>
  extractSignal({
    tool: 'Edit',
    tool_input: { file_path, old_string: oldStr, new_string: newStr },
  });

const w = (file_path: string, content: string) =>
  extractSignal({ tool: 'Write', tool_input: { file_path, content } });

const lines = (n: number, suffix = ''): string =>
  Array.from({ length: n }, (_, i) => `line${i.toString()}${suffix}`).join('\n');

describe('threshold evaluator — non-trivial classification', () => {
  describe('≥5-line edits flip out of trivial', () => {
    it('exactly 5 lines no public surface stays trivial under low', () => {
      const s = e('src/foo.ts', '', lines(5));
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'low' });
      expect(v.kind).toBe('trivial');
    });

    it('6 lines flips to non-trivial under low', () => {
      const s = e('src/foo.ts', '', lines(6));
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'low' });
      expect(v.kind).toBe('non-trivial');
    });

    it('any size flips to non-trivial under medium (small-edit not in TRIVIAL set)', () => {
      const s = e('src/foo.ts', '', lines(2));
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'medium' });
      expect(v.kind).toBe('non-trivial');
    });

    it('any size flips to non-trivial under high', () => {
      const s = e('src/foo.ts', '', lines(2));
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'high' });
      expect(v.kind).toBe('non-trivial');
    });
  });

  describe('public-surface touches flip out of trivial', () => {
    it('export keyword in new content under low → non-trivial', () => {
      const s = e('src/api.ts', '', 'export const x = 1');
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'low' });
      expect(v.kind).toBe('non-trivial');
    });

    it('module.exports in Write content under low → non-trivial', () => {
      const s = w('lib/cjs.js', 'module.exports = function(){}');
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'low' });
      expect(v.kind).toBe('non-trivial');
    });

    it('Spring annotation under low → non-trivial', () => {
      const s = w('app/Controller.java', '@PostMapping("/v2/x") void x() {}');
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'low' });
      expect(v.kind).toBe('non-trivial');
    });

    it('non-public small edit stays trivial under low', () => {
      const s = e('src/foo.ts', 'const a = 1', 'const a = 2');
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'low' });
      expect(v.kind).toBe('trivial');
    });
  });

  describe('dependency additions flip out of trivial', () => {
    it('editing package.json under low → non-trivial', () => {
      const s = e('package.json', '{}', '{"deps":{"x":"1.0.0"}}');
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'low' });
      expect(v.kind).toBe('non-trivial');
    });

    it('editing requirements.txt under low → non-trivial', () => {
      const s = e('requirements.txt', '', 'requests==2.31');
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'low' });
      expect(v.kind).toBe('non-trivial');
    });

    it('Bash with `npm install <pkg>` under low → non-trivial', () => {
      const s = extractSignal({ tool: 'Bash', tool_input: { command: 'npm install lodash' } });
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'low' });
      expect(v.kind).toBe('non-trivial');
    });

    it('Bash with `pip install <pkg>` under low → non-trivial', () => {
      const s = extractSignal({ tool: 'Bash', tool_input: { command: 'pip install requests' } });
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'low' });
      expect(v.kind).toBe('non-trivial');
    });

    it('Bash that does not introduce a dependency stays at non-trivial-equiv (no signal)', () => {
      const s = extractSignal({ tool: 'Bash', tool_input: { command: 'echo hello' } });
      // Bash with empty affected_paths and no dep introduction — no signal flips
      // it. With aggressiveness 'low' and small-edit's affected_paths.length===1
      // gate, this should miss the trivial classifier and fall through to non-trivial
      // when no signed plan exists.
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: 'low' });
      expect(v.kind).toBe('non-trivial');
    });
  });

  describe('aggressiveness monotonicity', () => {
    const cases: Aggressiveness[] = ['low', 'medium', 'high'];
    it.each(cases)('a small non-public edit is at most-trivial-at-low for %s', (agg) => {
      const s = e('src/foo.ts', 'a', 'b');
      const v = evaluate({ signal: s, signed_plan: null, aggressiveness: agg });
      if (agg === 'low') {
        expect(v.kind).toBe('trivial');
      } else {
        expect(v.kind).toBe('non-trivial');
      }
    });
  });

  describe('force-engage overrides triviality', () => {
    it('force_engage_pending=true makes a 1-line edit non-trivial', () => {
      const s = e('src/foo.ts', 'a', 'b');
      const v = evaluate({
        signal: s,
        signed_plan: null,
        aggressiveness: 'low',
        force_engage_pending: true,
      });
      expect(v.kind).toBe('non-trivial');
    });
  });
});
