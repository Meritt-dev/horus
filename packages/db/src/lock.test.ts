import { afterEach, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDbLock } from './client.js';
const roots: string[] = [];
const children: ChildProcess[] = [];
const path = () => { const root = mkdtempSync(join(tmpdir(), 'horus-lock-')); roots.push(root); return join(root, 'db'); };
const spawn = (p: string, mode: string) => {
  const child = fork(fileURLToPath(new URL('./lock-child.fixture.ts', import.meta.url)), [p, mode], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child); return child;
};
afterEach(() => { for (const c of children.splice(0)) c.kill('SIGKILL'); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
it('recovers a killed owner and abandoned choosing/reaper records without a TTL', async () => {
  const p = path(); const child = spawn(p, 'hold');
  const exited = once(child, 'exit');
  expect((await once(child, 'message'))[0]).toEqual({ locked: true });
  child.kill('SIGKILL'); await exited;
  unlinkSync(`${p}.critical`);
  writeFileSync(`${p}.lock.reap`, '2147483647 dead-owner');
  writeFileSync(join(`${p}.lock.owners`, 'dead-choosing'), '2147483647 0');
  writeFileSync(join(`${p}.lock.owners`, 'dead.tmp'), '');
  const release = await acquireDbLock(p, 1000);
  expect(existsSync(`${p}.lock.reap`)).toBe(false);
  release();
}, 30000);
it('independent processes never enter the critical section together during recovery', async () => {
  const p = path(); mkdirSync(`${p}.lock.owners`);
  writeFileSync(`${p}.lock`, '2147483647 dead-owner');
  writeFileSync(`${p}.lock.reap`, '2147483647 dead-reaper');
  const errors: unknown[] = [];
  const contenders = Array.from({ length: 6 }, () => spawn(p, 'contend'));
  await Promise.all(contenders.map(child => {
    child.on('message', m => { if ((m as { error?: string }).error) errors.push(m); });
    return once(child, 'exit').then(([code]) => expect(code).toBe(0));
  }));
  expect(errors).toEqual([]);
  expect(existsSync(`${p}.lock`)).toBe(false);
}, 60000);
it('never steals live or anonymous legacy ownership', async () => {
  const p = path(); writeFileSync(`${p}.lock`, `${process.pid} 0`);
  await expect(acquireDbLock(p, 10)).rejects.toThrow('HORUS_DB_BUSY');
  expect(existsSync(`${p}.lock`)).toBe(true);
  writeFileSync(`${p}.lock`, '');
  await expect(acquireDbLock(p, 10)).rejects.toThrow('anonymous legacy marker');
  unlinkSync(`${p}.lock`); writeFileSync(`${p}.lock.reap`, '');
  await expect(acquireDbLock(p, 10)).rejects.toThrow('anonymous legacy marker');
});
