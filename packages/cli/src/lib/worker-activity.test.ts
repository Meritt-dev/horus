import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { activityPath, claudeActivityArgs, hookActivity, readActivity, workerActivitySchema } from './worker-activity.js';

it('isolates the Claude session, discards raw content, bounds records and quotes trusted hook arguments', () => {
  const session = randomUUID(), job = randomUUID();
  const raw = { session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'secret-token' }, tool_response: 'private-log', transcript_path: '/private/user-session' };
  const event = hookActivity(raw, session, job)!;
  expect(event).toMatchObject({ jobId: job, kind: 'tool-start', action: 'Bash' });
  expect(JSON.stringify(event)).not.toMatch(/secret-token|private-log|transcript_path/);
  expect(hookActivity(raw, randomUUID(), job)).toBeUndefined();
  expect(hookActivity({ ...raw, hook_event_name: 'Unknown' }, session, job)).toBeUndefined();
  expect(hookActivity({ ...raw, tool_name: 'mcp__private_provider__read' }, session, job)?.action).toBe('connected-tool');
  expect(() => workerActivitySchema.parse({ ...event, command: 'secret' })).toThrow();
  const args = claudeActivityArgs('/node', [], "/app with 'quote'/index.cjs", session, job);
  expect(args.slice(0, 2)).toEqual(['--session-id', session]);
  const command = JSON.parse(args[3]!).hooks.PreToolUse[0].hooks[0].command;
  expect(command).toContain("'/app with '\"'\"'quote'\"'\"'/index.cjs'");
  expect(command).not.toContain('secret-token');
  const dir = mkdtempSync(join(tmpdir(), 'horus-activity-'));
  try {
    const path = activityPath(dir, session);
    writeFileSync(path, Array.from({ length: 110 }, () => JSON.stringify({ ...event, id: randomUUID() })).join('\n') + '\n{"partial":');
    expect(readActivity(path, job)).toHaveLength(100);
    expect(readActivity(path, randomUUID())).toEqual([]);
    expect(() => activityPath(dir, '../../escape')).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
