# Runtime connectors added in 0.23.0

Horus reads these sources through the existing `investigate` pipeline. Run the setup
commands in the project checkout. Add `--env <name>` to select its environment.

```sh
horus connect azure-monitor --workspace <workspace-guid> --subscription <subscription-id>
horus connect cloudwatch --region us-east-2 --log-group <log-group> --profile <aws-profile>
horus connect gcp-logging --gcp-project <project-id>
horus connect prometheus --url http://localhost:9090 --queries '[{"title":"API error rate","expr":"rate(http_requests_total{status=~\"5..\"}[5m])"}]'
horus connect azure-service-bus --namespace-id /subscriptions/<id>/resourceGroups/<group>/providers/Microsoft.ServiceBus/namespaces/<namespace> --queues <queue-name>
horus connect kafka --brokers <host>:9093 --topics <topic> --groups <consumer-group>
horus connect firestore --gcp-project <project-id> --collections <collection-path>
horus connect sqlserver --database <database> --schema dbo --tables <table>

horus status --json
horus investigate "orders are waiting" --logs-since 24h --json
horus logs --all-levels --since 24h --json
horus queues --live --json
horus metrics --query up --since 1h --json
```

Cloud readers reuse `az login`, `aws sso login --profile …`, or `gcloud auth login`.
They never start interactive login. Use `--executable /absolute/path/to/vendor-cli`
where the executable is not on PATH. Azure Monitor's subscription selects the tenant.
SQL Server prompts for its connection string; use a SELECT-only account. Kafka uses
TLS by default (`--no-ssl` is for trusted local brokers), and supports plain/SCRAM
SASL via `--username`, `--password` and `--mechanism`. Prometheus accepts `--token`.
Secrets use the existing encrypted connector store.

## Evidence and limits

| Connector | Evidence | Boundaries |
|---|---|---|
| Azure Monitor | Log Analytics/Application Insights events | Explicit workspace, subscription and tables; up to 200 rows |
| CloudWatch Logs | Structured or text log events | Explicit region, profile and log group; up to five pages/200 rows |
| Google Cloud Logging | Firebase Functions and other Google logs | Explicit project and optional `--filter`; up to 200 rows |
| Prometheus | Range samples and existing anomaly analysis | Configured queries; at most 1,001 time points per range |
| Azure Service Bus | Active, dead-letter and scheduled counts | Explicit namespace and queue allowlist; management reads only |
| Kafka | Topic end offsets, committed group offsets, lag | Explicit topics/groups; unknown lag stays unknown; no consume/commit/reset |
| Firestore | Counts and conventional date/status fields | Explicit collection paths; status discovery samples 200 projected documents and at most 25 values |
| SQL Server | Counts, latest dates and grouped status counts | Explicit schema/table allowlist, fixed SELECTs, validated identifiers, bounded connection/query timeouts |

The engine keeps its existing 15-row structured-log cap per source. These are bounded
evidence samples, not exhaustive exports. Broker counts do not establish worker
starvation. SQL Server's read-only intent controls routing; database permissions
must enforce read-only access. Query cost depends on table size and indexes.

When both exist, diagnostic `logs` prefers Elasticsearch and metrics prefer Grafana.
Investigations collect native cloud logs alongside Elasticsearch/Axiom. Runtime-only
investigations work without a source host and disclose the missing source intelligence.
These providers add evidence; they do not add background trigger adapters.

## Verification

Read-only local runs against actual configured cloud services collected Azure Monitor,
CloudWatch and Google Cloud logs, Service Bus counts, and Firestore aggregates.
Isolated Kafka and Prometheus servers verified actual wire protocols and built CLI
commands. Kafka offsets were unchanged by collection. SQL Server 2022 was exercised through built `connect`, `status` and `investigate`
commands with a SELECT-only login: three state evidence rows, unchanged table row
count, a rejected DELETE, and no plaintext credential in configuration or output. No production records or queue messages were modified.

The connector-only checkout passed workspace typechecks, the full JavaScript test
suite, the standalone CLI build and release smoke checks. Regression checks cover
redaction, scope rejection, encrypted credentials, metric bounds, integer-safe Kafka
lag and integration with the canonical runtime-only investigation pipeline.
