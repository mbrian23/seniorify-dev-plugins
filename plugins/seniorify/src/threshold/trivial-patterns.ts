// Trivial-pattern matcher (research.md §2). Pure function; called by the
// threshold evaluator (T030) on every PreToolUse hook invocation. The matcher
// is keyed by `effective_aggressiveness` per FR-001a — moving from low → high
// monotonically removes classes from "trivial," increasing engagement.
//
// T043 (US2 phase) is the canonical home for this module; T030 calls it.

import type { ExtractedSignal } from './signals.js';
import type { Aggressiveness } from '../backend/schemas/engagement-event.js';


export type TrivialClass =
  | 'read-only'
  | 'single-file-rename'
  | 'comment-typo'
  | 'formatter-autofix'
  | 'lockfile-regen'
  | 'whitespace-only'
  | 'small-edit-no-public-surface';

const TRIVIAL_BY_AGGRESSIVENESS: Record<Aggressiveness, ReadonlySet<TrivialClass>> = {
  low: new Set([
    'single-file-rename',
    'comment-typo',
    'formatter-autofix',
    'lockfile-regen',
    'whitespace-only',
    'small-edit-no-public-surface',
  ]),
  medium: new Set([
    'single-file-rename',
    'comment-typo',
    'formatter-autofix',
    'lockfile-regen',
    'whitespace-only',
  ]),
  high: new Set(['single-file-rename', 'formatter-autofix', 'lockfile-regen']),
};

const SMALL_EDIT_LINE_THRESHOLD = 5;

export const classifyTrivial = (
  signal: ExtractedSignal,
  aggressiveness: Aggressiveness,
): TrivialClass | null => {
  const allowed = TRIVIAL_BY_AGGRESSIVENESS[aggressiveness];

  if (
    signal.tool !== 'Edit' &&
    signal.tool !== 'Write' &&
    signal.tool !== 'MultiEdit' &&
    signal.tool !== 'NotebookEdit' &&
    signal.tool !== 'Bash'
  ) {
    return 'read-only';
  }

  // Lockfile regen — touching a lockfile is trivial regardless of size.
  if (allowed.has('lockfile-regen') && isLockfileRegen(signal)) {
    return 'lockfile-regen';
  }

  // Small-edit-no-public-surface — covers the most common trivial path under
  // `low` aggressiveness. Strictly bounded: ≤5 diff lines, single file, no
  // public-surface touch, no dependency add.
  if (
    allowed.has('small-edit-no-public-surface') &&
    !signal.is_public_surface_touch &&
    !signal.introduces_dependency &&
    signal.diff_lines <= SMALL_EDIT_LINE_THRESHOLD &&
    signal.affected_paths.length === 1
  ) {
    return 'small-edit-no-public-surface';
  }

  return null;
};

const isLockfileRegen = (signal: ExtractedSignal): boolean => {
  if (signal.affected_paths.length === 0) return false;
  const lockfileRx = /(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/u;
  return signal.affected_paths.every((p) => lockfileRx.test(p));
};
