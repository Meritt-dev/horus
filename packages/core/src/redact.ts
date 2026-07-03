/**
 * Secret / PII redaction (HOR-325, promoted from connectors HOR-91).
 *
 * Two tiers of aggressiveness:
 *   - `redactSecrets`  — the original conservative set (auth tokens, password/
 *     secret KV, cookies, connection-string creds, card numbers). Used wherever
 *     behavior must stay unchanged (e.g. Elasticsearch log evidence). One
 *     deliberate extension over HOR-91: connection-string credential stripping
 *     is scheme-generic (`scheme://user:pass@` for ANY scheme, empty usernames
 *     included), so `https://user:pass@grafana` baseUrls and `redis://:pass@`
 *     URLs are covered too. Two patterns share the work: known DB/broker
 *     schemes keep the HOR-91 '/'-permissive password class (base64-style
 *     passwords with raw '/' stay covered), while the generic-scheme pattern
 *     excludes '/', ',' and ';' from userinfo so `https://host/path@x` and
 *     comma-separated log tokens never false-positive.
 *   - `redactContent`  — the conservative set PLUS PII/credentials (emails, IPs,
 *     JWTs, cloud/provider keys, private keys). Used before any free-text content
 *     leaves the machine as Tier-B telemetry.
 *
 * `redactOrDrop` adds a fail-closed guard: if scrubbing throws, or a high-risk
 * pattern still remains afterward, the content is DROPPED rather than sent.
 */

type Replacement = [RegExp, string];

// Conservative, known-bad patterns — safe to apply to log evidence (HOR-91).
const BASE_PATTERNS: Replacement[] = [
  [/(authorization\s*[=:]\s*)(bearer\s+)[^\s,"')]+/gi, '$1$2[REDACTED]'],
  [/(authorization\s*[=:]\s*)(basic\s+)[^\s,"')]+/gi, '$1$2[REDACTED]'],
  [
    /("?(?:password|passwd|secret|token|api[_-]key|apikey|x-api-key)"?\s*[=:]\s*)"?[^"',\s)>]+/gi,
    '$1[REDACTED]',
  ],
  [/((?:cookie|set-cookie)\s*[=:]\s*)[^\s"',;>]{4,}/gi, '$1[REDACTED]'],
  // Known DB/broker schemes: password may contain raw '/' (HOR-91 behavior
  // preserved — base64-style passwords). Runs before the generic pattern.
  [
    /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/)[^:@/\s]*:[^@\s]+@/gi,
    '$1[REDACTED]@',
  ],
  // Scheme-generic URL userinfo (`scheme://user:pass@`, empty username allowed).
  // '/' excluded per RFC 3986 userinfo grammar (`https://host/path@x` is not
  // userinfo); ',' and ';' excluded so comma-separated log tokens after a URL
  // never read as credentials.
  [/([a-z][a-z0-9+.-]*:\/\/)[^:@/\s,;]*:[^@/\s,;]+@/gi, '$1[REDACTED]@'],
  [/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, '[REDACTED-CARD]'],
];

// Aggressive PII/credential patterns — only for content that leaves the machine.
const EXTENDED_PATTERNS: Replacement[] = [
  // PEM private key blocks (run first — multi-line, highest risk).
  [
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    '[REDACTED-PRIVATE-KEY]',
  ],
  // JSON Web Tokens (three base64url segments starting with the `{"` header).
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED-JWT]'],
  // AWS access key ids.
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED-AWS-KEY]'],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED-GCP-KEY]'],
  // Slack tokens.
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDACTED-SLACK-TOKEN]'],
  // GitHub tokens.
  [/\bgh[pousr]_[0-9A-Za-z]{36,}\b/g, '[REDACTED-GH-TOKEN]'],
  // Emails.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED-EMAIL]'],
  // IPv4 addresses.
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED-IP]'],
];

// If any of these survive redaction, something slipped — fail closed and drop.
const RESIDUAL_HIGH_RISK: RegExp[] = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
];

function apply(patterns: Replacement[], input: string): string {
  let out = input;
  for (const [pattern, replacement] of patterns) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Conservative scrub (auth/secret/card/conn-string). HOR-91 set, with the conn-string pattern generalized to any URL scheme. */
export function redactSecrets(input: string): string {
  return apply(BASE_PATTERNS, input);
}

/** Redact an unknown caught error's message (Error or not) — for connector health() details. */
export function redactErrorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

/** Redact-then-cap an upstream response body before it is interpolated into a thrown Error. */
export function redactUpstreamBody(text: string, max = 200): string {
  return redactSecrets(text).slice(0, max);
}

/** Aggressive scrub for content leaving the machine: secrets + PII + provider keys. */
export function redactContent(input: string): string {
  return apply(EXTENDED_PATTERNS, apply(BASE_PATTERNS, input));
}

export interface RedactionResult {
  /** The redacted string, or null when dropped. */
  value: string | null;
  /** True when content was dropped because redaction failed or a secret survived. */
  dropped: boolean;
}

/**
 * Fail-closed redaction: returns the scrubbed string, or `{ value: null,
 * dropped: true }` if scrubbing throws or a high-risk pattern remains afterward.
 */
export function redactOrDrop(input: string): RedactionResult {
  try {
    const value = redactContent(input);
    if (RESIDUAL_HIGH_RISK.some((p) => p.test(value))) {
      return { value: null, dropped: true };
    }
    return { value, dropped: false };
  } catch {
    return { value: null, dropped: true };
  }
}
