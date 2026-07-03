/**
 * @horus/knowledge — local project-knowledge index schema + store (HOR-291).
 *
 * The contract that `horus init` (HOR-293), the Maison Safqa import adapter
 * (HOR-292), `horus knowledge` (HOR-294), Horus MCP (HOR-295), and optional
 * cloud sync (HOR-296) all build against. Local-first; never requires Cloud.
 */
export * from './schema.js';
export * from './layout.js';
export * from './store.js';
export * from './query.js';
export * from './import/index.js';
export * from './build/project-landscape.js';
export * from './build/source-graph.js';
