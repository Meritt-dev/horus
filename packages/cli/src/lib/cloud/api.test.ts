import { afterEach, expect, it, vi } from 'vitest';
import { CloudClient, CloudError } from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('preserves rate limits through non-JSON gateway errors and ignores malformed Retry-After', async () => {
  for (const [header, expected] of [
    ['120', 120000],
    ['invalid', undefined],
  ] as const) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('upstream busy', {
            status: 429,
            headers: { 'Retry-After': header },
          }),
      ),
    );
    const error = await new CloudClient('http://localhost', 'test-token')
      .me()
      .catch((e) => e);
    expect(error).toBeInstanceOf(CloudError);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(expected);
  }
});

it('sends a report notification checkpoint through Cloud without a Slack credential', async () => {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ state: 'off' })),
  );
  vi.stubGlobal('fetch', fetch);
  const input = {
    notificationKey: 'job:report',
    hint: 'Timeout',
    cause: 'Cause uncertain',
    confidence: 0,
  };
  expect(
    await new CloudClient('https://api.horus.test', 'cloud-token').notifyInvestigation(
      'project',
      'report',
      input,
    ),
  ).toEqual({ state: 'off' });
  expect(fetch.mock.calls[0]?.[0]).toBe(
    'https://api.horus.test/v1/projects/project/investigations/report/notify',
  );
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
});

function slowResponse() {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  // Preserve real timer ordering without waiting 15 or 120 seconds in CI.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => timeout(ms / 1000));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal!;
      return new Response(
        new ReadableStream({
          start(controller) {
            const onAbort = () => {
              clearTimeout(timer);
              controller.error(signal.reason);
            };
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', onAbort);
              controller.enqueue(new TextEncoder().encode('{}'));
              controller.close();
            }, 30);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          },
        }),
      );
    }),
  );
}

it('allows slow knowledge upload responses and downloads while ordinary requests still time out', async () => {
  slowResponse();
  const client = new CloudClient('https://api.horus.test', 'cloud-token');
  await expect(client.getLatestKnowledgeSnapshot('project')).resolves.toEqual({});
  await expect(
    client.pushKnowledgeSnapshot('project', {
      schemaVersion: 1,
      contentHash: 'snapshot',
      generatedAt: '2026-10-11T00:00:00Z',
      snapshot: {},
      manifest: {},
    }),
  ).resolves.toEqual({});
  await expect(client.me()).rejects.toThrow();
});

it('keeps caller cancellation effective during a slow knowledge response', async () => {
  slowResponse();
  const controller = new AbortController();
  const client = new CloudClient(
    'https://api.horus.test',
    'cloud-token',
    controller.signal,
  );
  const response = client.getLatestKnowledgeSnapshot('project');
  controller.abort(new Error('caller stopped'));
  await expect(response).rejects.toThrow('caller stopped');
});
