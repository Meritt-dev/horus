import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const bundle = process.env.HORUS_RECALL_REVIEW_BUNDLE;
if (!bundle) {
  const message =
    'Private recall evidence is absent; release quality gate is unverified.';
  if (process.env.HORUS_REQUIRE_RECALL_REVIEW === '1') throw new Error(message);
  console.log(`::notice::${message}`);
} else {
  const dir = mkdtempSync(join(tmpdir(), 'horus-recall-'));
  try {
    const data = JSON.parse(
      gunzipSync(Buffer.from(bundle, 'base64'), { maxOutputLength: 2 * 1024 * 1024 }),
    );
    const history = join(dir, 'history.json');
    const labels = join(dir, 'review.json');
    writeFileSync(history, JSON.stringify(data.history), { mode: 0o600 });
    writeFileSync(labels, JSON.stringify(data.review), { mode: 0o600 });
    const env = {
      ...process.env,
      HORUS_RECALL_HISTORY: history,
      HORUS_RECALL_LABELS: labels,
    };
    delete env.HORUS_RECALL_REVIEW_BUNDLE;
    const result = spawnSync('pnpm', ['exec', 'tsx', 'scripts/test-recall-history.ts'], {
      env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
