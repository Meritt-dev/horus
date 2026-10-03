import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const workerActivitySchema = z.object({
  id: z.string().uuid(), at: z.string().datetime({ offset: true }), jobId: z.string().uuid(),
  kind: z.enum(['stage', 'tool-start', 'tool-end', 'tool-error', 'agent-start', 'agent-finish', 'error']),
  action: z.enum(['engine', 'recall', 'collect', 'ai', 'upload', 'notify', 'complete', 'done', 'Read', 'Grep', 'Glob', 'Bash', 'connected-tool', 'agent', 'other-tool']),
}).strict();
export type WorkerActivity = z.infer<typeof workerActivitySchema>;
export function activityPath(home: string, sessionId: string) {
  return join(home, `activity-${z.string().uuid().parse(sessionId)}.jsonl`);
}
export function activityEvent(jobId: string, kind: WorkerActivity['kind'], action: WorkerActivity['action']): WorkerActivity {
  return workerActivitySchema.parse({ id: randomUUID(), at: new Date().toISOString(), jobId, kind, action });
}
export function hookActivity(raw: unknown, sessionId: string, jobId: string): WorkerActivity | undefined {
  const input = z.object({ session_id: z.literal(sessionId), hook_event_name: z.string(), tool_name: z.string().optional() }).safeParse(raw);
  if (!input.success) return;
  const kinds: Record<string, WorkerActivity['kind']> = { SessionStart: 'agent-start', Stop: 'agent-finish', PreToolUse: 'tool-start', PostToolUse: 'tool-end', PostToolUseFailure: 'tool-error' };
  const kind = kinds[input.data.hook_event_name];
  if (!kind) return;
  const tool = input.data.tool_name;
  const action = !tool ? 'agent' : ['Read', 'Grep', 'Glob', 'Bash'].includes(tool) ? tool as WorkerActivity['action'] : tool.startsWith('mcp__') ? 'connected-tool' : 'other-tool';
  // Discard every raw field, including tool arguments, output, paths and error text.
  return activityEvent(jobId, kind, action);
}
export async function recordActivityHook(home: string, sessionId: string, jobId: string) {
  let file: number | undefined;
  try {
    const path = activityPath(home, sessionId);
    z.string().uuid().parse(jobId);
    // Only write the private file prepared by the owning worker, never arbitrary hook paths.
    file = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    const stat = fstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 64_000) return;
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString();
      if (input.length > 1_000_000) return;
    }
    const event = hookActivity(JSON.parse(input), sessionId, jobId);
    if (event) writeSync(file, JSON.stringify(event) + '\n');
  } catch { /* Observability never controls Claude execution. */ }
  finally { if (file !== undefined) closeSync(file); }
}
export function readActivity(path: string, jobId: string): WorkerActivity[] {
  let file: number | undefined;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (fstatSync(file).size > 65_000) return [];
    return readFileSync(file, 'utf8').split('\n').flatMap(line => {
      try { const event = workerActivitySchema.parse(JSON.parse(line)); return event.jobId === jobId ? [event] : []; }
      catch { return []; } // A concurrent writer may leave an incomplete final line.
    }).slice(-100);
  } catch { return []; }
  finally { if (file !== undefined) closeSync(file); }
}
export function claudeActivityArgs(runtime: string, runtimeArgs: string[], entry: string, sessionId: string, jobId: string) {
  z.string().uuid().parse(sessionId); z.string().uuid().parse(jobId);
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const command = [runtime, ...runtimeArgs, entry, 'service', 'activity', '--session', sessionId, '--job', jobId].map(quote).join(' ');
  const hook = [{ hooks: [{ type: 'command', command, timeout: 5 }] }];
  return ['--session-id', sessionId, '--settings', JSON.stringify({ hooks: {
    SessionStart: hook, PreToolUse: hook, PostToolUse: hook, PostToolUseFailure: hook, Stop: hook,
  } })];
}
