import { beforeEach, describe, it, expect, vi } from 'vitest';
import { CloudLogsProvider, cloudLogRecord } from './provider.js';
import { nativeJson } from './native-cli.js';
import { fetchWithRetry } from '../http.js';
vi.mock('./native-cli.js', () => ({ nativeJson: vi.fn() }));
vi.mock('../http.js', () => ({ fetchWithRetry: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
describe('native cloud log evidence', () => {
  it('normalizes union columns, Pino vs Azure severity, timestamps and redaction', () => {
    const azure = cloudLogRecord('azure-monitor', {
      Message: '',
      Log_s: '{"message":"reserve failed","level":50}',
      TimeGenerated: '2026-09-27T10:00:00Z',
    });
    expect(
      cloudLogRecord('cloudwatch', {
        message: '[WARN] configure this to turn the timeout into an error',
      }).fields.level,
    ).toBe('warn');
    expect(
      cloudLogRecord('cloudwatch', { message: 'an error count was zero' }).fields.level,
    ).toBe('info');
    expect(azure.fields.message).toBe('reserve failed');
    expect(azure.fields.level).toBe('error');
    expect(
      cloudLogRecord('gcp-logging', { jsonPayload: { message: 'completed', level: 30 } })
        .fields.level,
    ).toBe('info');
    expect(
      cloudLogRecord('azure-monitor', { Message: 'failed', SeverityLevel: 3 }).fields
        .level,
    ).toBe('error');
    expect(
      cloudLogRecord('cloudwatch', {
        timestamp: 1750000000000,
        message: 'password=secret123',
      }).fields.message,
    ).not.toContain('secret123');
  });
  it('pins Azure token to the configured subscription; token stays out of command args', async () => {
    vi.mocked(nativeJson).mockResolvedValue({ accessToken: 'private-token' });
    vi.mocked(fetchWithRetry).mockResolvedValue(
      new Response(
        JSON.stringify({
          tables: [{ columns: [{ name: 'Message' }], rows: [['failed']] }],
        }),
      ),
    );
    const p = new CloudLogsProvider('azure-monitor', {
      workspace: '9ad70c8c-bfd9-4985-b021-b3abb628564b',
      subscription: 'subscription-a',
      tables: ['AppTraces'],
      executable: 'az',
    });
    expect((await p.collect({ hintTerms: ['bad" | take 9'] }))[0]?.fields.message).toBe(
      'failed',
    );
    expect(vi.mocked(nativeJson).mock.calls[0]![1]).toContain('subscription-a');
    expect(JSON.stringify(vi.mocked(nativeJson).mock.calls)).not.toContain(
      'private-token',
    );
    const body = JSON.parse(vi.mocked(fetchWithRetry).mock.calls[0]![1]!.body as string);
    expect(body.query).toContain('contains "bad\\" | take 9"');
  });
  it('follows empty CloudWatch pages and stops a repeated continuation token', async () => {
    vi.mocked(nativeJson)
      .mockResolvedValueOnce({ events: [], nextToken: 'next' })
      .mockResolvedValueOnce({
        events: [{ message: 'reserve error', timestamp: 1750000000000 }],
        nextToken: 'next',
      });
    const p = new CloudLogsProvider('cloudwatch', {
      region: 'ap-south-1',
      logGroup: '/api',
      profile: 'local',
      executable: 'aws',
    });
    expect(await p.collect({ hintTerms: ['reserve'] })).toHaveLength(1);
    expect(nativeJson).toHaveBeenCalledTimes(2);
    expect(vi.mocked(nativeJson).mock.calls[1]![1]).toContain('--next-token');
    expect(vi.mocked(nativeJson).mock.calls[0]![1]).toContain('--filter-pattern');
  });
  it('rejects provider error envelopes and invalid windows instead of reporting an empty success', async () => {
    const p = new CloudLogsProvider('gcp-logging', {
      project: 'project-a',
      filter: '',
      executable: 'gcloud',
    });
    await expect(p.collect({ from: 'bad' })).rejects.toThrow('Invalid log time window');
    expect(nativeJson).not.toHaveBeenCalled();
    vi.mocked(nativeJson).mockResolvedValue({ error: 'denied' });
    expect((await p.health()).ok).toBe(false);
  });
});
