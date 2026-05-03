// AgentActionSignal extractor. Pure function — no I/O, no clock, no random.
// Given a Claude Code PreToolUse payload, returns the structured signal the
// threshold evaluator and engagement-event log need.
//
// Per `contracts/pretooluse-hook.md`: unknown tools pass through with an empty
// affected_paths set so the evaluator classifies them as read-only / trivial.
// Detection of public-surface touches and dependency adds is intentionally
// path-pattern based — Constitution §II / SC-004 forbid an LLM call here.

import { z } from 'zod';

const editInputSchema = z.object({
  file_path: z.string().min(1),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
});

const writeInputSchema = z.object({
  file_path: z.string().min(1),
  content: z.string().default(''),
});

const multiEditInputSchema = z.object({
  file_path: z.string().min(1),
  edits: z
    .array(
      z.object({
        old_string: z.string().optional().default(''),
        new_string: z.string().optional().default(''),
      }),
    )
    .default([]),
});

const notebookEditInputSchema = z.object({
  notebook_path: z.string().min(1),
  new_source: z.string().optional(),
  cell_id: z.string().optional(),
});

const bashInputSchema = z.object({
  command: z.string().min(1),
});

const PUBLIC_SURFACE_PATTERNS: readonly RegExp[] = [
  /\bexport\s+(default\s+)?(async\s+)?(function|class|const|let|var|interface|type|enum)\b/u,
  /\bmodule\.exports\b/u,
  /\bexports\.[A-Za-z_]/u,
  /\b(Get|Post|Put|Patch|Delete|Options|Head)Mapping\b/u,
];

const DEPENDENCY_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)package\.json$/u,
  /(^|\/)pnpm-lock\.yaml$/u,
  /(^|\/)yarn\.lock$/u,
  /(^|\/)package-lock\.json$/u,
  /(^|\/)requirements\.txt$/u,
  /(^|\/)pyproject\.toml$/u,
  /(^|\/)go\.mod$/u,
  /(^|\/)Cargo\.toml$/u,
  /(^|\/)Gemfile$/u,
];

const PACKAGE_INSTALL_BASH = [
  /\bnpm\s+(i|install|add)\b/u,
  /\bpnpm\s+(add|install|i)\b/u,
  /\byarn\s+(add|install)\b/u,
  /\bbun\s+add\b/u,
  /\bpip\s+install\b/u,
  /\bpoetry\s+add\b/u,
  /\bgo\s+get\b/u,
  /\bcargo\s+add\b/u,
  /\bgem\s+install\b/u,
];

const isPublicSurfaceTouch = (text: string | undefined): boolean => {
  if (text === undefined || text.length === 0) return false;
  return PUBLIC_SURFACE_PATTERNS.some((rx) => rx.test(text));
};

const isDependencyFile = (path: string): boolean =>
  DEPENDENCY_FILE_PATTERNS.some((rx) => rx.test(path));

const introducesDependencyFromBash = (command: string): boolean =>
  PACKAGE_INSTALL_BASH.some((rx) => rx.test(command));

const countLines = (s: string | undefined): number => {
  if (s === undefined || s.length === 0) return 0;
  // Count newline-separated lines; trailing newline does not add a line.
  let count = 1;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) === 10) count += 1;
  }
  if (s.endsWith('\n')) count -= 1;
  return count;
};

export interface ExtractInput {
  readonly tool: string;
  readonly tool_input: unknown;
}

export interface ExtractedSignal {
  readonly tool: string;
  readonly affected_paths: string[];
  readonly diff_lines: number;
  readonly is_public_surface_touch: boolean;
  readonly introduces_dependency: boolean;
}

export const extractSignal = (input: ExtractInput): ExtractedSignal => {
  switch (input.tool) {
    case 'Edit': {
      const parsed = editInputSchema.safeParse(input.tool_input);
      if (!parsed.success) return emptySignal('Edit');
      const oldLines = countLines(parsed.data.old_string);
      const newLines = countLines(parsed.data.new_string);
      const diffLines = Math.max(oldLines, newLines);
      const surface =
        isPublicSurfaceTouch(parsed.data.old_string) ||
        isPublicSurfaceTouch(parsed.data.new_string);
      return {
        tool: 'Edit',
        affected_paths: [parsed.data.file_path],
        diff_lines: diffLines,
        is_public_surface_touch: surface,
        introduces_dependency: isDependencyFile(parsed.data.file_path),
      };
    }
    case 'Write': {
      const parsed = writeInputSchema.safeParse(input.tool_input);
      if (!parsed.success) return emptySignal('Write');
      return {
        tool: 'Write',
        affected_paths: [parsed.data.file_path],
        diff_lines: countLines(parsed.data.content),
        is_public_surface_touch: isPublicSurfaceTouch(parsed.data.content),
        introduces_dependency: isDependencyFile(parsed.data.file_path),
      };
    }
    case 'MultiEdit': {
      const parsed = multiEditInputSchema.safeParse(input.tool_input);
      if (!parsed.success) return emptySignal('MultiEdit');
      let diffLines = 0;
      let surface = false;
      for (const e of parsed.data.edits) {
        diffLines += Math.max(countLines(e.old_string), countLines(e.new_string));
        if (isPublicSurfaceTouch(e.old_string) || isPublicSurfaceTouch(e.new_string)) {
          surface = true;
        }
      }
      return {
        tool: 'MultiEdit',
        affected_paths: [parsed.data.file_path],
        diff_lines: diffLines,
        is_public_surface_touch: surface,
        introduces_dependency: isDependencyFile(parsed.data.file_path),
      };
    }
    case 'NotebookEdit': {
      const parsed = notebookEditInputSchema.safeParse(input.tool_input);
      if (!parsed.success) return emptySignal('NotebookEdit');
      return {
        tool: 'NotebookEdit',
        affected_paths: [parsed.data.notebook_path],
        diff_lines: countLines(parsed.data.new_source),
        is_public_surface_touch: false,
        introduces_dependency: false,
      };
    }
    case 'Bash': {
      const parsed = bashInputSchema.safeParse(input.tool_input);
      if (!parsed.success) return emptySignal('Bash');
      return {
        tool: 'Bash',
        affected_paths: [],
        diff_lines: 0,
        is_public_surface_touch: false,
        introduces_dependency: introducesDependencyFromBash(parsed.data.command),
      };
    }
    default:
      return emptySignal(input.tool);
  }
};

const emptySignal = (tool: string): ExtractedSignal => ({
  tool,
  affected_paths: [],
  diff_lines: 0,
  is_public_surface_touch: false,
  introduces_dependency: false,
});
