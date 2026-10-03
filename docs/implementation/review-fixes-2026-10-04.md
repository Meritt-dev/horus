# Runtime review fixes — October 4, 2026

Extends the existing database ownership function, durable memory outbox/Cloud sync route, and Prometheus provider. No parallel investigation engine, provider or storage tier.

- Database contenders publish complete ownership records and use ordered tickets to serialize recovery. Killed participants and identified dead cleanup owners recover without a TTL. Live owners never expire. Anonymous markers from older versions fail closed: stop every older Horus command using that database before manually clearing its anonymous `.lock` or `.lock.reap`. Updated versions never publish anonymous markers. Hosted coverage includes a killed owner and six concurrent subprocesses.
- Oversized memory snapshots upload deterministic bounded pages through the existing sync route. Existing operation receipts store staging pages; no migration is required. The complete snapshot becomes visible in one revisioned transaction after every page arrives. The local outbox retains its full frozen snapshot and acknowledged page cursor. Retries preserve lost-response idempotency, conflicts, link deletions and append-only audit. Previously valid frozen requests retain their original wire content and identity. Total staged receipt content is capped at 32 MiB before loading it for finalization; an oversized operation is rejected without publication.
- Staged requests use `history:<revision>`, which older Cloud schemas reject before mutation. Deploy the companion Cloud change before using these CLI changes. Small records keep the numeric revision protocol. New clients restore links/audit through the existing paginated endpoints, pinning pages to the item revision; local application/cursor advancement happens after hydration. Legacy inline responses have an 8 MiB page budget (one complete item may exceed it) and a 32 MiB inline history limit. Hosted paired coverage restores 2,101 links and 2,102 audit rows on a clean profile after losing a page acknowledgement.
- Prometheus uses Grafana's title/query hint matching and series-label fallback, including match-source metadata. Unmatched fallback series are excluded; no hint still allows all configured queries.

## Verification and scope

No local unit, end-to-end, integration, replay or service lifecycle suites ran. Local checks are TypeScript compilation and whitespace checks. Hosted CI is the execution gate. The frozen Maison worker is unchanged during implementation and review; a source commit does not claim it is running these fixes.

HOR-CLI/HOR-CORE own memory replication and database use; HOR-CONNECTORS owns Prometheus. Existing service PR #43 owns the CLI work. The available Linear connector returns Zaigo issues and no Horus issues; prior Horus mappings remain historical. No new ticket was created, as requested.

## Interrogate disposition

Reviewers A and C independently caught mixed-version partial publication; acted on by making old Cloud reject the revision protocol. C's PostgreSQL parameter limit finding was acted on by batching target/report lookups and inserts. Both reread the corrections and reported no remaining findings. These were available Codex reviewers; configured Claude aliases are unavailable and family diversity is limited. Reviewer B identified unbounded aggregate/pull work and missing OpenAPI fields. Acted on by bounding total staging before loading it, paginating history on the existing endpoints, bounding inline responses, and regenerating the public contract. The changed bounds/pull path is under re-review; hosted execution is pending.
