export interface PresetQuery {
  label: string;
  query: string;
}

export const PRESET_QUERIES: PresetQuery[] = [
  {
    label: 'All dead code',
    query:
      "MATCH (n:Function) WHERE n.is_dead = true RETURN n.name, n.file_path, n.start_line",
  },
  {
    label: 'Most called',
    query:
      "MATCH ()-[r:CodeRelation]->(t:Function) WHERE r.rel_type = 'calls' RETURN t.name, count(r) AS calls ORDER BY calls DESC LIMIT 20",
  },
  {
    label: 'Import map',
    query:
      "MATCH (a:File)-[r:CodeRelation]->(b:File) WHERE r.rel_type = 'imports' RETURN a.name AS from, b.name AS to",
  },
  {
    label: 'Coupled files',
    query:
      "MATCH (a:File)-[r:CodeRelation]->(b:File) WHERE r.rel_type = 'coupled_with' RETURN a.name, b.name, r.strength ORDER BY r.strength DESC",
  },
  {
    label: 'Entry points',
    query:
      "MATCH (n:Function) WHERE n.is_entry_point = true RETURN n.name, n.file_path",
  },
  {
    label: 'Largest classes',
    query:
      "MATCH (m:Method) WHERE m.class_name <> '' RETURN m.class_name AS class, count(m) AS methods ORDER BY methods DESC LIMIT 10",
  },
  {
    label: 'Cross-community calls',
    query:
      "MATCH (a)-[r:CodeRelation]->(b) WHERE r.rel_type = 'calls' AND a.id <> b.id MATCH (a)-[:CodeRelation]->(c1:Community), (b)-[:CodeRelation]->(c2:Community) WHERE c1.id <> c2.id RETURN a.name, b.name, c1.name, c2.name LIMIT 50",
  },
];

export const RESULTS_PAGE_SIZE = 50;
export const MAX_HISTORY_ENTRIES = 20;
