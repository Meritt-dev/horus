import { describe, it, expect } from 'vitest';
import {
  redactSecrets,
  redactContent,
  redactOrDrop,
  redactErrorMessage,
  redactUpstreamBody,
} from './redact.js';

describe('redactSecrets (conservative — ES log behavior)', () => {
  it('redacts bearer tokens, secret KV, conn-string creds, and card numbers', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toContain('[REDACTED]');
    expect(redactSecrets('password=hunter2 other=ok')).toBe('password=[REDACTED] other=ok');
    expect(redactSecrets('postgres://user:secret@host:5432/db')).toBe(
      'postgres://[REDACTED]@host:5432/db',
    );
    expect(redactSecrets('card 4111 1111 1111 1111 end')).toContain('[REDACTED-CARD]');
  });

  it('does NOT touch emails or IPs (stays conservative for log evidence)', () => {
    expect(redactSecrets('contact a@b.com from 10.0.0.1')).toBe('contact a@b.com from 10.0.0.1');
  });

  it('leaves ordinary text unchanged', () => {
    expect(redactSecrets('checkout latency spiked on the scheduler')).toBe(
      'checkout latency spiked on the scheduler',
    );
  });

  it('strips URL userinfo for ANY scheme, including empty usernames', () => {
    expect(redactSecrets('redis://:s3cret@localhost:6379')).toBe(
      'redis://[REDACTED]@localhost:6379',
    );
    expect(redactSecrets('rediss://default:pw@h')).toBe('rediss://[REDACTED]@h');
    expect(redactSecrets('https://elastic:pw@es.example.com:9200')).toBe(
      'https://[REDACTED]@es.example.com:9200',
    );
    expect(redactSecrets('mongodb+srv://u:p@cluster/db')).toBe(
      'mongodb+srv://[REDACTED]@cluster/db',
    );
    expect(redactSecrets('amqp://u:p@h')).toBe('amqp://[REDACTED]@h');
  });

  it('does NOT touch credential-free URLs ("/" is excluded from the password class)', () => {
    expect(redactSecrets('https://example.com/path')).toBe('https://example.com/path');
    expect(redactSecrets('https://host:9200/path@thing')).toBe('https://host:9200/path@thing');
    expect(redactSecrets('service://host:8080/x')).toBe('service://host:8080/x');
  });

  it('DB-scheme passwords containing raw "/" are still redacted (HOR-91 coverage)', () => {
    expect(redactSecrets('postgres://user:ab/Cd+eF@db.internal:5432/app')).toBe(
      'postgres://[REDACTED]@db.internal:5432/app',
    );
    expect(redactSecrets('mongodb+srv://u:p/w:d@cluster/db')).toBe(
      'mongodb+srv://[REDACTED]@cluster/db',
    );
    expect(redactSecrets('redis://:a/b@cache:6379')).toBe('redis://[REDACTED]@cache:6379');
  });

  it('does NOT mangle credential-free URLs inside comma-separated log tokens', () => {
    const line = 'upstream=https://api.example.com:8443,user=svc@corp,attempt=2';
    expect(redactSecrets(line)).toBe(line);
  });
});

describe('redactErrorMessage', () => {
  it('redacts an Error message', () => {
    const err = new Error('connect failed: postgres://user:secret@host:5432/db');
    expect(redactErrorMessage(err)).toBe('connect failed: postgres://[REDACTED]@host:5432/db');
  });

  it('redacts a plain string', () => {
    expect(redactErrorMessage('redis://:s3cret@localhost:6379 unreachable')).toBe(
      'redis://[REDACTED]@localhost:6379 unreachable',
    );
  });

  it('stringifies a non-Error object', () => {
    expect(redactErrorMessage({ code: 42 })).toBe('[object Object]');
    expect(redactErrorMessage(42)).toBe('42');
  });

  it('redacts every conn-string form embedded in an Error message', () => {
    for (const url of [
      'mongodb://u:p@host/db',
      'mongodb+srv://u:p@cluster/db',
      'https://user:pw@grafana.local',
      'redis://:pw@h:6379',
    ]) {
      const out = redactErrorMessage(new Error(`boom ${url}`));
      expect(out).toContain('[REDACTED]@');
      expect(out).not.toContain(':pw@');
      expect(out).not.toContain(':p@');
    }
  });
});

describe('redactUpstreamBody', () => {
  it('caps the body at 200 chars by default', () => {
    const out = redactUpstreamBody('x'.repeat(500));
    expect(out).toHaveLength(200);
  });

  it('accepts a custom cap', () => {
    expect(redactUpstreamBody('x'.repeat(500), 50)).toHaveLength(50);
  });

  it('redacts BEFORE slicing — a secret starting before the cap never survives partially', () => {
    // The conn string starts at char 180; a slice-then-redact would leave a
    // partial credential ("postgres://user:s3cr…") that no pattern matches.
    const body = 'x'.repeat(180) + 'postgres://user:s3cretpassword@host:5432/db' + 'y'.repeat(100);
    const out = redactUpstreamBody(body);
    expect(out).toHaveLength(200);
    expect(out).not.toContain('s3cr');
    expect(body.slice(0, 200)).toContain('s3cr'); // sanity: naive slice WOULD leak
  });
});

describe('redactContent (aggressive — content leaving the machine)', () => {
  it('redacts emails and IPs', () => {
    const out = redactContent('user jane@acme.io at 192.168.1.20');
    expect(out).toContain('[REDACTED-EMAIL]');
    expect(out).toContain('[REDACTED-IP]');
    expect(out).not.toContain('jane@acme.io');
  });

  it('redacts JWTs, AWS keys, GCP keys, Slack/GitHub tokens, and private keys', () => {
    expect(redactContent('tok eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJ end')).toContain('[REDACTED-JWT]');
    expect(redactContent('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED-AWS-KEY]');
    expect(redactContent('AIza' + 'a'.repeat(35))).toContain('[REDACTED-GCP-KEY]');
    // Assembled from parts so no real secret-shaped literal lives in source — keeps
    // secret scanning / push protection happy while feeding the redactor the same input.
    const slackToken = ['xoxb', '123456789012', 'abcdefghijklmnop'].join('-');
    expect(redactContent(`tok ${slackToken}`)).toContain('[REDACTED-SLACK-TOKEN]');
    const ghToken = 'ghp_' + '0123456789abcdefghijklmnopqrstuvwxyz12';
    expect(redactContent(ghToken)).toContain('[REDACTED-GH-TOKEN]');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(redactContent(`key: ${pem}`)).toContain('[REDACTED-PRIVATE-KEY]');
  });

  it('also applies the conservative base patterns', () => {
    expect(redactContent('password=hunter2')).toBe('password=[REDACTED]');
  });
});

describe('redactOrDrop (fail-closed)', () => {
  it('returns the scrubbed value for normal content', () => {
    const r = redactOrDrop('investigate checkout latency for jane@acme.io');
    expect(r.dropped).toBe(false);
    expect(r.value).toContain('[REDACTED-EMAIL]');
    expect(r.value).not.toContain('jane@acme.io');
  });

  it('does not leak a high-risk secret in the returned value', () => {
    const r = redactOrDrop('here is a token AKIAIOSFODNN7EXAMPLE and a jwt eyJa.eyJb.cccc');
    expect(r.dropped).toBe(false);
    expect(r.value).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(r.value).not.toMatch(/eyJa\.eyJb\.cccc/);
  });
});
