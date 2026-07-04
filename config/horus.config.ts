import { defineConfig } from '@horus/core';

/**
 * Horus configuration. See `horusConfigSchema` in @horus/core for the full shape.
 *
 * Project/environment scoped. The model separates code from runtime:
 *   - CODE belongs to the PROJECT: `repositories[]`, each served by the
 *     source-intelligence backend.
 *   - RUNTIME belongs to the ENVIRONMENT: `environments[].connectors` (Elasticsearch,
 *     MongoDB, Grafana, Redis/BullMQ).
 *
 * All connector secrets are read from environment variables at runtime (never
 * committed here). Default env-var names (overridable via *Env fields):
 *   ES_URL / ES_USERNAME / ES_PASSWORD
 *   GRAFANA_URL / GRAFANA_USER / GRAFANA_PASSWORD
 *   MONGODB_URL
 *
 * Transport note: Horus talks to the source-intelligence backend over HTTP/MCP only.
 * Start a host with
 *   `horus-source host --port <N>`  (run inside, or pointed at, each indexed repo)
 * and set the repository's `source.hostUrl` to it. No CLI shell-outs for queries.
 */
export default defineConfig({
  projects: [
    {
      name: 'leadcall-api',
      // Code belongs to the project — the source-intelligence backend serves each repository.
      repositories: [
        {
          name: 'leadcall-api',
          path: '/Users/mhmdh/Documents/projects/meritt-dev/leadcall-api',
          source: { hostUrl: 'http://127.0.0.1:8420' },
        },
      ],
      // Runtime belongs to the environment.
      environments: [
        {
          name: 'production',
          readOnly: true,
          connectors: {
            elasticsearch: {
              indexPattern: 'leadcall-api-prod-*',
              serviceName: 'leadcall-api-prod',
            },
            mongodb: {
              // leadcall has its OWN Mongo cluster — a separate URL from maison's.
              // Set LEADCALL_MONGODB_URL to enable it; unset => "not configured" here.
              urlEnv: 'LEADCALL_MONGODB_URL',
              database: 'leadcall_prod',
              collections: ['calls', 'tenants', 'devices', 'integrations'],
            },
            grafana: {},
          },
        },
      ],
    },
    {
      name: 'maison-safqa',
      repositories: [
        {
          name: 'maison-safqa',
          path: '/Users/mhmdh/Documents/projects/meritt-dev/maison-safqa',
          source: { hostUrl: 'http://127.0.0.1:8421' },
        },
      ],
      environments: [
        {
          name: 'production',
          readOnly: true,
          connectors: {
            elasticsearch: {
              indexPattern: 'maison-safqa-*',
              serviceName: 'maison-safqa-prod',
            },
            mongodb: {
              // Uses the default MONGODB_URL (the maison cluster reachable here).
              database: 'maison-safqa',
              collections: [
                'gaiasynclogs',
                'gaiaproducts',
                'scheduleconfigs',
                'orders',
                'instas',
                'products',
                'brands',
                'suppliers',
                'users',
              ],
            },
            grafana: {
              dashboard: 'maison-safqa-technical-overview',
            },
          },
        },
      ],
    },
  ],

  // Local persistence is embedded (bundled pglite at ~/.horus/horus.db) — no `database`
  // block needed. Teams that need shared state use Horus Cloud, not a self-run Postgres.

  models: {
    reasoning: 'claude-opus-4-8',
    extraction: 'claude-haiku-4-5',
  },
});
