/**
 * Repo cloud-context store: `<repo>/.horus/cloud.json` (HOR-225 § Config).
 *
 * Holds IDs + slugs only — never the token. Safe to commit (teams may share the
 * cloud context) or git-ignore for per-developer choice.
 *
 * CACHE, NOT A CONNECTION OR AN AUTH BOUNDARY (HOR-298): the stored cloud
 * org/workspace/project IDs+slugs are a convenience cache of *which* Cloud project
 * this repo syncs to. They do NOT change the CLI's local persistence:
 * `context: "cloud"` selects the `/v1` API sync target only — the CLI engine still
 * uses its embedded local database (bundled pglite at `~/.horus/horus.db`) for all
 * local execution state. The CLI never connects to the Cloud database, and the
 * Cloud API re-checks the caller's authorization server-side on every sync/write,
 * so a stale or hand-edited `cloud.json` can never grant access or repoint the DB.
 * See docs/cloud-vs-cli-databases.md.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { cloudConfigPath } from "./paths.js";

export interface Ref {
  id: string;
  slug: string;
}

/**
 * @deprecated A project IS the repository/codebase now (HOR-280). The CLI context
 * UX no longer exposes or writes a separate Repository (HOR-278). This type is
 * retained only so the legacy investigation-sync path still type-checks; new
 * configs never populate it and `context show` / `cloud status` never display it.
 */
export interface RepositoryRef {
  id?: string;
  slug: string;
}

export interface CloudConfig {
  /** Where this repo's investigations are stored. */
  context: "local" | "cloud";
  organization?: Ref;
  workspace?: Ref;
  project?: Ref;
  /** @deprecated HOR-278 — Project is the repository. Not written by new configs. */
  repository?: RepositoryRef;
}

export function readCloudConfig(root: string): CloudConfig | null {
  const p = cloudConfigPath(root);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<CloudConfig>;
    if (parsed.context !== "local" && parsed.context !== "cloud") return null;
    return parsed as CloudConfig;
  } catch {
    return null;
  }
}

export function writeCloudConfig(root: string, cfg: CloudConfig): void {
  const p = cloudConfigPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}

export function clearCloudConfig(root: string): void {
  const p = cloudConfigPath(root);
  if (existsSync(p)) rmSync(p);
}

/** True when the repo is actively storing investigations in the cloud. */
export function isCloudActive(cfg: CloudConfig | null): cfg is CloudConfig {
  return !!cfg && cfg.context === "cloud" && !!cfg.project;
}
