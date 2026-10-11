# Code relationships in Cloud paths

`horus init` retains a bounded projection of recorded source relationships in the
optional `sourceRelationships` snapshot field. Refresh knowledge from an indexed
source host, then use the existing `horus knowledge push` command to sync it.

The projection contains `calls`, `extends`, `implements`, and `uses_type` edges
between existing operations, types and enums. Endpoints use exact source node IDs
when mapping onto knowledge IDs. Ambiguous overloads, missing symbols and capped
entities are omitted and mark the projection truncated. Names, folders, community
membership and process ordering never create connections.

Recorded numeric confidence is preserved; absent or invalid confidence remains
null. Source bodies, embeddings, and the remainder of the raw source graph stay
local. Older snapshots and hosts remain compatible: the field is optional, and
failure of the optional read-only source query does not prevent knowledge indexing.

Deploy the compatible Cloud reader before publishing/syncing the producer. Cloud
Explore includes these exact connections in its existing shortest-hop tracing and
animation. Timeline remains memory history. A truncated view can only find paths
within the returned graph; it cannot prove that disconnected endpoints have no
path in the full source graph.

Local builds, typecheck and lint are permitted. Behavioral and cross-repository
contract checks run in hosted CI; fixture paths are not production-provider proof.
