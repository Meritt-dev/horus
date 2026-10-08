import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildWebhookPayload,
  notificationCause,
  signPayload,
  shouldNotify,
  dispatchNotify,
  type NotifyHeadline,
} from './notify-sink.js';
import type { NotifyConfig } from '@horus/core';

const H: NotifyHeadline = {
  investigationId: 'inv_1',
  hint: 'orders failing to sync',
  cause: 'Runtime error EMODA_008 token refresh',
  confidence: 0.82,
};

describe('buildWebhookPayload', () => {
  it('produces a Slack-compatible text line + structured fields', () => {
    const p = buildWebhookPayload(H);
    expect(p['text']).toContain('orders failing to sync');
    expect(p['text']).toContain('82%');
    expect(p['investigationId']).toBe('inv_1');
    expect(p['confidence']).toBe(0.82);
  });
});

describe('signPayload', () => {
  it('is a stable sha256= HMAC of the exact body under the secret', () => {
    const sig = signPayload('{"a":1}', 'shh');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // deterministic
    expect(signPayload('{"a":1}', 'shh')).toBe(sig);
    // sensitive to body + secret
    expect(signPayload('{"a":2}', 'shh')).not.toBe(sig);
    expect(signPayload('{"a":1}', 'other')).not.toBe(sig);
  });
});

describe('shouldNotify', () => {
  it('false when no sink configured', () => {
    expect(shouldNotify(0.9, undefined)).toBe(false);
    expect(shouldNotify(0.9, { minConfidence: 0.6, cloud: false } as NotifyConfig)).toBe(false);
  });
  it('gates on the threshold when a target is configured', () => {
    const n = { minConfidence: 0.6, cloud: false, webhook: { url: 'https://x' } } as NotifyConfig;
    expect(shouldNotify(0.59, n)).toBe(false);
    expect(shouldNotify(0.6, n)).toBe(true);
    expect(shouldNotify(0.9, n)).toBe(true);
  });
});

describe('dispatchNotify', () => {
  afterEach(() => vi.restoreAllMocks());
  const report = { id: 'inv_1', confidence: 0.82, hint: H.hint, cause: H.cause };

  it('returns [] (no fetch) when below threshold', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const n = { minConfidence: 0.95, cloud: false, webhook: { url: 'https://x' } } as NotifyConfig;
    const res = await dispatchNotify(report, n);
    expect(res).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs a signed webhook on success', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const n = { minConfidence: 0.6, cloud: false, webhook: { url: 'https://hook', secret: 's' } } as NotifyConfig;
    const res = await dispatchNotify(report, n);
    expect(res).toEqual([{ target: 'webhook', ok: true, detail: 'HTTP 200' }]);
    const [, init] = fetchSpy.mock.calls[0]!;
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-horus-signature']).toMatch(/^sha256=/);
  });

  it('reports a failed webhook without throwing (loop survives)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }));
    const n = { minConfidence: 0.6, cloud: false, webhook: { url: 'https://hook' } } as NotifyConfig;
    const res = await dispatchNotify(report, n);
    expect(res).toEqual([{ target: 'webhook', ok: false, detail: 'HTTP 500' }]);
  });

  it('reports a thrown fetch as a failure, never rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const n = { minConfidence: 0.6, cloud: false, webhook: { url: 'https://hook' } } as NotifyConfig;
    const res = await dispatchNotify(report, n);
    expect(res[0]?.ok).toBe(false);
    expect(res[0]?.detail).toBe('network down');
  });

  it('runs an injected cloudPush when cloud:true', async () => {
    const cloudPush = vi.fn().mockResolvedValue(undefined);
    const n = { minConfidence: 0.6, cloud: true } as NotifyConfig;
    const res = await dispatchNotify(report, n, { cloudPush });
    expect(cloudPush).toHaveBeenCalledOnce();
    expect(res).toEqual([{ target: 'cloud', ok: true, detail: 'pushed' }]);
  });
});

describe('unattended result context', () => {
  it('keeps uncertain AI uncertain and includes bounded, redacted evidence and history', () => {
    const report = {
      suspectedCauses: [{ title: 'Engine hypothesis' }],
      evidence: [{ id: 'e1', title: 'Current timeout token=private-value' },
        { id: 'e2', title: 'Uncited evidence' }],
      startupRecall: [{ memoryId: 'm1', claim: 'Prior timeout', outcome: { certainty: 'confirmed' },
        validation: 'contradicted' }],
    } as unknown as import('@horus/engine').InvestigationReport;
    const ai = { reportId: 'r1', summary: 'Timed out', likelyCause: null, confidence: 0.1,
      evidenceIds: ['e1'], historicalMemoryIds: ['m1'], nextChecks: ['Check upstream'],
      uncertainty: 'Evidence is insufficient' };
    const text = notificationCause(report, ai);
    for (const value of ['Cause uncertain', 'Evidence is insufficient', 'e1: Current timeout',
      'Historical context (not current proof)', 'm1 (confirmed, contradicted)', 'Next: Check upstream'])
      expect(text).toContain(value);
    for (const value of ['private-value', 'Uncited evidence', 'Engine hypothesis']) expect(text).not.toContain(value);
    expect(notificationCause({ ...report, evidence: [], startupRecall: [] }, undefined, true))
      .toContain('Engine-only (AI failed). Engine hypothesis. Current cause remains unconfirmed. Current evidence: none cited.');
    expect(notificationCause({ ...report, evidence: [{ ...report.evidence[0]!, title: 'x'.repeat(5000) }] }).length).toBeLessThan(1000);
  });
});
