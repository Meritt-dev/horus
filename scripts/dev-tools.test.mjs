import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('current receipt rejects unknown fields, stale summaries and unverified publication', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horus-receipt-'));
  try {
    const path = join(dir, 'receipt.json');
    const source = JSON.parse(
      readFileSync('docs/implementation/current-release.json', 'utf8'),
    );
    writeFileSync(path, JSON.stringify(source));
    execFileSync('python3', ['scripts/release-receipt.py', 'render', path]);
    assert.equal(
      spawnSync('python3', ['scripts/release-receipt.py', 'release', path]).status,
      1,
    );
    writeFileSync(path, JSON.stringify({ ...source, ci: source.ci.slice(0, 1) }));
    assert.equal(
      spawnSync('python3', ['scripts/release-receipt.py', 'render', path]).status,
      1,
    );
    writeFileSync(
      path,
      JSON.stringify({
        ...source,
        ci: source.ci.map((run) => ({ ...run, headSha: 'f'.repeat(40) })),
      }),
    );
    assert.equal(
      spawnSync('python3', ['scripts/release-receipt.py', 'render', path]).status,
      1,
    );
    writeFileSync(path, JSON.stringify(source));
    writeFileSync(path.replace('.json', '.md'), 'stale');
    assert.equal(
      spawnSync('python3', ['scripts/release-receipt.py', 'check', path]).status,
      1,
    );
    writeFileSync(path, JSON.stringify({ ...source, token: 'must-never-render' }));
    assert.equal(
      spawnSync('python3', ['scripts/release-receipt.py', 'render', path]).status,
      1,
    );
    assert.equal(readFileSync(path.replace('.json', '.md'), 'utf8'), 'stale');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publication rejects missing recall evidence while ordinary CI explicitly reports it', () => {
  const env = { ...process.env };
  delete env.HORUS_RECALL_REVIEW_BUNDLE;
  delete env.HORUS_REQUIRE_RECALL_REVIEW;
  const ordinary = spawnSync(process.execPath, ['scripts/run-recall-review.mjs'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(ordinary.status, 0);
  assert.match(ordinary.stdout, /unverified/);
  const release = spawnSync(process.execPath, ['scripts/run-recall-review.mjs'], {
    env: { ...env, HORUS_REQUIRE_RECALL_REVIEW: '1' },
  });
  assert.equal(release.status, 1);
});

test('CI observer emits job changes only and fetches failed logs once across continuations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horus-ci-observer-'));
  try {
    writeFileSync(
      join(dir, 'gh'),
      `#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\np=Path(${JSON.stringify(join(dir, 'calls'))})\np.open('a').write(' '.join(sys.argv[1:])+'\\n')\nif '--log-failed' in sys.argv:print('one failure log')\nelse:print(json.dumps({'status':'completed','conclusion':'failure','headSha':'a'*40,'url':'https://github.com/owner/repo/actions/runs/1','jobs':[{'databaseId':2,'name':'build','status':'completed','conclusion':'failure'}]}))\n`,
      { mode: 0o700 },
    );
    const args = [
      resolve('scripts/ci-watch.py'),
      'owner/repo',
      '1',
      '--state',
      join(dir, 'state.json'),
    ];
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    const first = spawnSync('python3', args, { env, encoding: 'utf8' });
    const next = spawnSync('python3', args, { env, encoding: 'utf8' });
    assert.equal(first.status, 1);
    assert.equal(next.status, 1);
    assert.match(first.stdout, /build: completed failure/);
    assert.doesNotMatch(next.stdout, /build:|one failure log/);
    assert.equal(
      readFileSync(join(dir, 'calls'), 'utf8').split('--log-failed').length - 1,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lint rejects discarded async promises in a tracked TypeScript file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horus-lint-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    const path = join(dir, 'unsafe.ts');
    writeFileSync(path, 'items.forEach(async (item) => { await save(item); });\n');
    execFileSync('git', ['-C', dir, 'add', 'unsafe.ts']);
    const result = spawnSync(process.execPath, [resolve('scripts/lint.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /async forEach discards promises/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CI observer bounds an unfinished run without inventing a failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horus-ci-deadline-'));
  try {
    writeFileSync(
      join(dir, 'gh'),
      '#!/usr/bin/env python3\nimport json\nprint(json.dumps({"status":"in_progress","conclusion":"","headSha":"a"*40,"url":"https://github.com/owner/repo/actions/runs/1","jobs":[]}))\n',
      { mode: 0o700 },
    );
    const result = spawnSync(
      'python3',
      [
        resolve('scripts/ci-watch.py'),
        'owner/repo',
        '1',
        '--deadline',
        '1',
        '--state',
        join(dir, 'state.json'),
      ],
      {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.equal(result.status, 3);
    assert.match(result.stdout, /retained state, no failure inferred/);
    assert.equal(
      JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).logsFetched,
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CI observer distinguishes network errors from a concluded CI failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horus-ci-unavailable-'));
  try {
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const result = spawnSync(
      'python3',
      [resolve('scripts/ci-watch.py'), 'owner/repo', '1'],
      { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.match(result.stdout, /no run conclusion inferred/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
