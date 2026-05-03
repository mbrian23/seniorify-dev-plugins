// Cross-process state shared between the hook (one process per invocation),
// the MCP server (one persistent process per session), and slash commands
// (run via the markdown command surface). Per-session JSON state files
// live in `${CLAUDE_PLUGIN_ROOT}/.state/<session_id>.json`. The store is
// best-effort: a corrupt file is treated as "no state" and overwritten —
// hook decisions never block on state-store failures (the engagement
// log is the load-bearing audit-trail entry, not this file).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { SessionId } from '../shared/types.js';

export interface SessionState {
  readonly force_engage_pending: boolean;
}

const EMPTY: SessionState = { force_engage_pending: false };

const stateRoot = (): string => {
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();
  return join(root, '.state');
};

const stateFile = (sessionId: SessionId): string => join(stateRoot(), `${sessionId}.json`);

export const loadState = async (sessionId: SessionId): Promise<SessionState> => {
  try {
    const raw = await readFile(stateFile(sessionId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'force_engage_pending' in parsed &&
      typeof (parsed as Record<string, unknown>).force_engage_pending === 'boolean'
    ) {
      return parsed as SessionState;
    }
    return EMPTY;
  } catch {
    return EMPTY;
  }
};

export const saveState = async (sessionId: SessionId, state: SessionState): Promise<void> => {
  const file = stateFile(sessionId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state), 'utf8');
};

export const clearForceEngage = async (sessionId: SessionId): Promise<void> => {
  await saveState(sessionId, { force_engage_pending: false });
};

export const armForceEngage = async (sessionId: SessionId): Promise<void> => {
  await saveState(sessionId, { force_engage_pending: true });
};
