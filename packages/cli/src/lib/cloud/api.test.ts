import { afterEach, expect, it, vi } from 'vitest';
import { CloudClient, CloudError } from './api.js';

afterEach(() => vi.unstubAllGlobals());
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
