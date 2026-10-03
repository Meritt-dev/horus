import { acquireDbLock } from './client.js';
import { openSync, closeSync, unlinkSync } from 'node:fs';
const [path, mode] = process.argv.slice(2);
try {
  for (let i = 0; i < (mode === 'contend' ? 3 : 1); i++) {
    const release = await acquireDbLock(path!, 15000);
    const guard = `${path}.critical`;
    const fd = openSync(guard, 'wx');
    process.send?.({ locked: true });
    if (mode === 'hold') await new Promise(() => { setInterval(() => {}, 1000); });
    await new Promise(r => setTimeout(r, 25));
    closeSync(fd); unlinkSync(guard); release();
  }
} catch (e) { process.send?.({ error: String(e) }); process.exitCode = 1; }
