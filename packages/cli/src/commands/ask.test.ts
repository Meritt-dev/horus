/**
 * HOR-319 (Bug 1) — `horus ask` must accept the id `investigate` prints as its header.
 *
 * That id is the LOCAL investigation id; in a cloud-linked repo `ask` used to send it
 * straight to the cloud API, which only knows its own id, so it 404'd. These tests pin
 * the fix: resolve LOCAL first, fall back to cloud, and surface a clear not-found.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => ({
  openDb: vi.fn(async () => ({ db: {}, sql: { end: vi.fn(async () => {}) } })),
  getInvestigation: vi.fn(),
}));
const cloud = vi.hoisted(() => ({
  isCloudActive: vi.fn(),
  fetchInvestigationReportFromCloud: vi.fn(),
  authedClient: vi.fn(() => ({ client: {} })),
  reportCloudError: vi.fn(() => 1),
}));
const engine = vi.hoisted(() => ({
  answerQuestion: vi.fn(() => ({ answer: 'because X' })),
  renderQAAnswer: vi.fn(() => 'ANSWER'),
  qaToJSON: vi.fn(() => '{}'),
  migrateReport: vi.fn((r: unknown) => r),
  refineInvestigation: vi.fn(),
  renderRefined: vi.fn(() => ''),
  refinedToJSON: vi.fn(() => '{}'),
}));
// HOR-331: fresh source lookup for code-locating questions.
const source = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  codeForRepo: vi.fn(),
  health: vi.fn(),
  searchSymbols: vi.fn(),
  context: vi.fn(),
}));

vi.mock('@horus/core', () => ({ loadConfig: source.loadConfig }));
vi.mock('@horus/connectors', () => ({ codeForRepo: source.codeForRepo }));
vi.mock('@horus/db', () => db);
vi.mock('@horus/engine', () => engine);
vi.mock('../lib/cloud/context-store.js', () => ({
  readCloudConfig: vi.fn(() => ({})),
  isCloudActive: cloud.isCloudActive,
}));
vi.mock('../lib/cloud/session.js', () => ({
  authedClient: cloud.authedClient,
  repoRootOrCwd: vi.fn(() => '/repo'),
}));
vi.mock('../lib/cloud/investigation-sync.js', () => ({
  fetchInvestigationReportFromCloud: cloud.fetchInvestigationReportFromCloud,
}));
vi.mock('../lib/cloud/api.js', () => ({
  CloudError: class CloudError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('./context.js', () => ({ reportCloudError: cloud.reportCloudError }));

import { runAsk, isCodeLocatingQuestion, extractSymbolQuery } from './ask.js';
import { CloudError } from '../lib/cloud/api.js';

const REPORT = { id: 'local-id', input: { hint: 'x' } };

beforeEach(() => {
  for (const fn of [
    ...Object.values(db),
    ...Object.values(cloud),
    ...Object.values(engine),
    ...Object.values(source),
  ]) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  db.openDb.mockResolvedValue({ db: {}, sql: { end: vi.fn(async () => {}) } });
  cloud.authedClient.mockReturnValue({ client: {} });
  cloud.reportCloudError.mockReturnValue(1);
  engine.answerQuestion.mockReturnValue({ answer: 'because X' });
  engine.renderQAAnswer.mockReturnValue('ANSWER');
  engine.migrateReport.mockImplementation((r: unknown) => r);
  // Default source wiring: reachable host, no matches (so plain questions fall through).
  source.loadConfig.mockResolvedValue({});
  source.codeForRepo.mockReturnValue({
    health: source.health,
    searchSymbols: source.searchSymbols,
    context: source.context,
  });
  source.health.mockResolvedValue({ ok: true, detail: '' });
  source.searchSymbols.mockResolvedValue([]);
  source.context.mockResolvedValue({});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('runAsk — cloud-linked repo (HOR-319 Bug 1)', () => {
  it('answers from the LOCAL store when given the local id, without calling cloud', async () => {
    cloud.isCloudActive.mockReturnValue(true);
    db.getInvestigation.mockResolvedValue({ report: REPORT });

    const code = await runAsk('local-id', 'why?', {});

    expect(code).toBe(0);
    expect(db.getInvestigation).toHaveBeenCalledWith(expect.anything(), 'local-id');
    expect(cloud.fetchInvestigationReportFromCloud).not.toHaveBeenCalled();
    expect(engine.answerQuestion).toHaveBeenCalled();
  });

  it('falls back to cloud when the id is not in the local store', async () => {
    cloud.isCloudActive.mockReturnValue(true);
    db.getInvestigation.mockResolvedValue(null);
    cloud.fetchInvestigationReportFromCloud.mockResolvedValue(REPORT);

    const code = await runAsk('cloud-id', 'why?', {});

    expect(code).toBe(0);
    expect(cloud.fetchInvestigationReportFromCloud).toHaveBeenCalledTimes(1);
  });

  it('reports a clear not-found (not a raw cloud error) when cloud 404s after a local miss', async () => {
    cloud.isCloudActive.mockReturnValue(true);
    db.getInvestigation.mockResolvedValue(null);
    cloud.fetchInvestigationReportFromCloud.mockRejectedValue(
      new CloudError(404, 'not_found', 'Investigation not found'),
    );

    const code = await runAsk('bogus', 'why?', {});

    expect(code).toBe(1);
    expect(cloud.reportCloudError).not.toHaveBeenCalled();
  });
});

describe('runAsk — local mode', () => {
  it('answers from the local store', async () => {
    cloud.isCloudActive.mockReturnValue(false);
    db.getInvestigation.mockResolvedValue({ report: REPORT });

    const code = await runAsk('local-id', 'why?', {});

    expect(code).toBe(0);
    expect(cloud.fetchInvestigationReportFromCloud).not.toHaveBeenCalled();
  });

  it('returns 1 with a not-found message when the id is unknown', async () => {
    cloud.isCloudActive.mockReturnValue(false);
    db.getInvestigation.mockResolvedValue(null);

    const code = await runAsk('missing', 'why?', {});

    expect(code).toBe(1);
  });
});

describe('isCodeLocatingQuestion (HOR-331)', () => {
  it('detects "where/which file/how … defined" phrasings', () => {
    expect(isCodeLocatingQuestion('where is processOrder defined?')).toBe(true);
    expect(isCodeLocatingQuestion('which file has the retry logic')).toBe(true);
    expect(isCodeLocatingQuestion('how is OrderService defined')).toBe(true);
    expect(isCodeLocatingQuestion('locate the webhook handler')).toBe(true);
  });

  it('detects a bare symbol-like token', () => {
    expect(isCodeLocatingQuestion('processOrder')).toBe(true);
    expect(isCodeLocatingQuestion('OrderService')).toBe(true);
    expect(isCodeLocatingQuestion('create_user')).toBe(true);
    expect(isCodeLocatingQuestion('foo()')).toBe(true);
  });

  it('does NOT flag reasoning questions about the saved report', () => {
    expect(isCodeLocatingQuestion('why is confidence not higher?')).toBe(false);
    expect(isCodeLocatingQuestion('what evidence is missing?')).toBe(false);
    expect(isCodeLocatingQuestion('focus on queue behavior')).toBe(false);
    expect(isCodeLocatingQuestion('retry')).toBe(false);
  });
});

describe('extractSymbolQuery (HOR-331)', () => {
  it('prefers symbol-like tokens', () => {
    expect(extractSymbolQuery('where is processOrder defined?')).toBe('processOrder');
  });

  it('falls back to non-stopword remainder when no symbol token is present', () => {
    expect(extractSymbolQuery('which file has the retry logic')).toBe('retry logic');
  });
});

describe('runAsk — code-locating question (HOR-331)', () => {
  const SYM = { id: 'fn:processOrder', name: 'processOrder', filePath: 'src/orders.ts', startLine: 42, endLine: 50 };

  it('answers from a FRESH source lookup, without touching the saved report', async () => {
    cloud.isCloudActive.mockReturnValue(false);
    source.searchSymbols.mockResolvedValue([SYM]);
    source.context.mockResolvedValue({ symbol: SYM, snippet: 'function processOrder() {}' });

    const code = await runAsk('inv-1', 'where is processOrder defined?', {});

    expect(code).toBe(0);
    expect(source.searchSymbols).toHaveBeenCalledWith('processOrder', 5);
    expect(source.context).toHaveBeenCalledWith('fn:processOrder');
    // Did NOT fall back to the saved-report path.
    expect(db.getInvestigation).not.toHaveBeenCalled();
    expect(engine.answerQuestion).not.toHaveBeenCalled();
  });

  it('emits JSON with file:line citations when --json is set', async () => {
    cloud.isCloudActive.mockReturnValue(false);
    source.searchSymbols.mockResolvedValue([SYM]);
    const logSpy = vi.spyOn(console, 'log');

    const code = await runAsk('inv-1', 'where is processOrder defined?', { json: true });

    expect(code).toBe(0);
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('src/orders.ts:42-50');
    expect(printed).toContain('source-host');
  });

  it('falls back to the saved report when no source connector is configured', async () => {
    cloud.isCloudActive.mockReturnValue(false);
    source.codeForRepo.mockImplementation(() => {
      throw new Error('No source-intelligence connector configured');
    });
    db.getInvestigation.mockResolvedValue({ report: REPORT });

    const code = await runAsk('local-id', 'where is processOrder defined?', {});

    expect(code).toBe(0);
    expect(db.getInvestigation).toHaveBeenCalledWith(expect.anything(), 'local-id');
    expect(engine.answerQuestion).toHaveBeenCalled();
  });

  it('falls back to the saved report when the source host is unreachable', async () => {
    cloud.isCloudActive.mockReturnValue(false);
    source.health.mockResolvedValue({ ok: false, detail: 'down' });
    db.getInvestigation.mockResolvedValue({ report: REPORT });

    const code = await runAsk('local-id', 'where is processOrder defined?', {});

    expect(code).toBe(0);
    expect(source.searchSymbols).not.toHaveBeenCalled();
    expect(engine.answerQuestion).toHaveBeenCalled();
  });

  it('falls back to the saved report on a host-miss (no symbol matched)', async () => {
    cloud.isCloudActive.mockReturnValue(false);
    source.searchSymbols.mockResolvedValue([]);
    db.getInvestigation.mockResolvedValue({ report: REPORT });

    const code = await runAsk('local-id', 'where is processOrder defined?', {});

    expect(code).toBe(0);
    expect(source.searchSymbols).toHaveBeenCalled();
    expect(engine.answerQuestion).toHaveBeenCalled();
  });
});
