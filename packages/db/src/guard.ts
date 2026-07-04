/**
 * Cloud-database guardrail (HOR-298).
 *
 * Horus's local state lives in the embedded database; the Horus Cloud Postgres is the
 * shared team source of truth. The CLI must reach Cloud ONLY through the `/v1` REST API —
 * never by opening a direct connection to the Cloud database. The remaining place a raw
 * Postgres URL is accepted is the one-time `horus db import --from <url>` cutover, so this
 * guard makes the boundary un-bypassable there: importing directly from the Cloud database
 * throws (use the API-backed sync instead).
 *
 * See `docs/cloud-vs-cli-databases.md`.
 */

/** Known Horus Cloud database markers (its database name and Postgres port). */
const CLOUD_DB_NAME = 'horus_cloud';
const CLOUD_DB_PORT = '5434';

export class CloudDatabaseUrlError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to connect: the URL points at the Horus Cloud database (${reason}). ` +
        `Cloud is reached through the /v1 REST API, never a direct DB connection. ` +
        `Import from your own local Postgres instead (do not point --from at the Cloud ` +
        `database / HORUS_CLOUD_DATABASE_URL). See docs/cloud-vs-cli-databases.md.`,
    );
    this.name = 'CloudDatabaseUrlError';
  }
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Why a URL looks like the Horus Cloud database, or `null` if it looks local.
 * Pure + side-effect free except for reading `HORUS_CLOUD_DATABASE_URL` from env.
 */
export function cloudDatabaseUrlReason(url: string): string | null {
  if (!url) return null;

  // Strongest signal: exact match to the configured Cloud DB URL.
  const cloudEnv = process.env['HORUS_CLOUD_DATABASE_URL'];
  if (cloudEnv && normalizeUrl(url) === normalizeUrl(cloudEnv)) {
    return 'matches HORUS_CLOUD_DATABASE_URL';
  }

  // Structured check via the URL parser; fall back to substring matching for
  // connection strings the WHATWG parser can't handle.
  try {
    const u = new URL(url);
    const dbName = u.pathname.replace(/^\/+/, '');
    if (dbName === CLOUD_DB_NAME) return `database name "${CLOUD_DB_NAME}"`;
    if (u.port === CLOUD_DB_PORT) return `Cloud port ${CLOUD_DB_PORT}`;
    return null;
  } catch {
    if (new RegExp(`/${CLOUD_DB_NAME}(\\b|$)`).test(url)) return `database name "${CLOUD_DB_NAME}"`;
    if (url.includes(`:${CLOUD_DB_PORT}`)) return `Cloud port ${CLOUD_DB_PORT}`;
    return null;
  }
}

/** True if `url` appears to point at the Horus Cloud database. */
export function looksLikeCloudDatabaseUrl(url: string): boolean {
  return cloudDatabaseUrlReason(url) !== null;
}

/**
 * Throw if `url` points at the Horus Cloud database. Call at every point that
 * opens a CLI database connection so the boundary can't be crossed silently.
 */
export function assertLocalDatabaseUrl(url: string): void {
  const reason = cloudDatabaseUrlReason(url);
  if (reason) throw new CloudDatabaseUrlError(reason);
}
