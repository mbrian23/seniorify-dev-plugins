// Layered threshold evaluator. Pure function: `(signal, signed_plan,
// aggressiveness) → Verdict`. Per research.md §2 step order and SC-004's
// 50ms p95 budget on the trivial path — this module MUST stay local-only.
//
// The signed-plan-scope check uses glob matching from `target_paths`; the
// "tolerated" `may_also_touch` paths are also accepted. Anything outside
// both falls to the divergence branch (only emitted when a signed plan
// exists; if no signed plan, we return 'non-trivial' instead).

import { classifyTrivial } from './trivial-patterns.js';

import type { ExtractedSignal } from './signals.js';
import type { TrivialClass } from './trivial-patterns.js';
import type { Aggressiveness } from '../backend/schemas/engagement-event.js';
import type { Plan } from '../backend/schemas/plan.js';



export type Verdict =
  | { readonly kind: 'trivial'; readonly trivial_class: TrivialClass }
  | { readonly kind: 'covered-by-signed-plan' }
  | { readonly kind: 'diverged-from-signed-plan'; readonly reason: 'path' | 'public-surface' | 'dependency' }
  | { readonly kind: 'non-trivial' };

export interface EvaluateInput {
  readonly signal: ExtractedSignal;
  readonly signed_plan: Plan | null;
  readonly aggressiveness: Aggressiveness;
  readonly force_engage_pending?: boolean;
}

export const evaluate = (input: EvaluateInput): Verdict => {
  // Layer 0: force-engage from /seniorify-audit overrides everything.
  if (input.force_engage_pending === true) {
    return { kind: 'non-trivial' };
  }

  // Layer 1: read-only tools never modify code → trivial.
  // Layer 2: write tools that match a TRIVIAL_PATTERN at this aggressiveness → trivial.
  const trivialClass = classifyTrivial(input.signal, input.aggressiveness);
  if (trivialClass !== null) {
    return { kind: 'trivial', trivial_class: trivialClass };
  }

  // Layer 3 & 4: scope check against signed plan, if any.
  if (input.signed_plan !== null) {
    const scope = inSignedScope(input.signal, input.signed_plan);
    if (scope.kind === 'covered') return { kind: 'covered-by-signed-plan' };
    return { kind: 'diverged-from-signed-plan', reason: scope.reason };
  }

  // Layer 5: fallthrough — engage.
  return { kind: 'non-trivial' };
};

type ScopeResult =
  | { readonly kind: 'covered' }
  | { readonly kind: 'diverged'; readonly reason: 'path' | 'public-surface' | 'dependency' };

const inSignedScope = (signal: ExtractedSignal, plan: Plan): ScopeResult => {
  // Dependency divergence first — a new top-level dep that was not declared.
  if (signal.introduces_dependency && plan.new_dependencies.length === 0) {
    return { kind: 'diverged', reason: 'dependency' };
  }

  // Path divergence — every affected path must match target_paths or may_also_touch.
  const allowedGlobs = [...plan.target_paths, ...plan.may_also_touch];
  for (const p of signal.affected_paths) {
    if (!allowedGlobs.some((g) => globMatch(g, p))) {
      return { kind: 'diverged', reason: 'path' };
    }
  }

  // Public-surface divergence — body-only declared, but signal touches surface.
  if (signal.is_public_surface_touch && plan.public_surface_changes.length === 0) {
    return { kind: 'diverged', reason: 'public-surface' };
  }

  return { kind: 'covered' };
};

/**
 * Minimal glob matcher supporting `**`, `*`, `?`. Path-aware: `*` does NOT
 * cross `/`, `**` does. Used by the divergence detector at hook time per
 * research.md §3 ("glob match at action time, not pre-expanded at sign time").
 */
export const globMatch = (pattern: string, path: string): boolean => {
  const rx = globToRegExp(pattern);
  return rx.test(path);
};

const globToRegExp = (pattern: string): RegExp => {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern.charAt(i);
    if (c === '*') {
      if (pattern.charAt(i + 1) === '*') {
        // `**` — match anything including separators.
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^$|()[]{}\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out, 'u');
};
