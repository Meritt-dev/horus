/**
 * `horus context list` / `horus context use` (HOR-226, per HOR-225).
 *
 * A "context" is where this repo's investigations are stored: `local` (default)
 * or a cloud `org/workspace/project`. The user selects a context — never a DB URL.
 */
import pc from "picocolors";
import type { ContextResponse } from "../lib/cloud/api.js";
import { CloudError, CloudOfflineError } from "../lib/cloud/api.js";
import { readCloudConfig, writeCloudConfig, isCloudActive } from "../lib/cloud/context-store.js";
import { authedClient, repoRootOrCwd } from "../lib/cloud/session.js";
import { selectSearch, isInteractive, ExitPromptError } from "../lib/tty-selector.js";

interface ResolvedTriple {
  organization: { id: string; slug: string };
  workspace: { id: string; slug: string };
  project: { id: string; slug: string };
}

/** The `local` sentinel offered as the first pick in the context selector. */
const LOCAL_CHOICE = "local  ·  ~/.horus local Postgres";

/**
 * Interactively pick an `org/workspace/project` triple (or `local`) from the
 * accessible cloud context — so the user never types a slug. Returns the chosen
 * target string (`"local"` or `"org/ws/project"`), or `null` if nothing is
 * pickable / the user is non-interactive (the caller then requires an explicit
 * target). Shared by `context use` and `cloud link`; reuses the same
 * `selectSearch` picker the connect wizard uses.
 */
export async function pickContextTarget(
  ctx: ContextResponse,
  opts: { includeLocal?: boolean; message?: string } = {},
): Promise<string | null> {
  const labels: string[] = [];
  const targetByLabel = new Map<string, string>();
  if (opts.includeLocal) {
    labels.push(LOCAL_CHOICE);
    targetByLabel.set(LOCAL_CHOICE, "local");
  }
  for (const project of ctx.projects) {
    const triple = tripleLabel(ctx, project.id);
    if (!triple) continue;
    // Show the human project name alongside the slug triple; return the triple.
    const label = project.name && project.name !== project.slug ? `${triple}  (${project.name})` : triple;
    labels.push(label);
    targetByLabel.set(label, triple);
  }
  if (targetByLabel.size === 0 || (opts.includeLocal && targetByLabel.size === 1)) {
    // Nothing to pick beyond `local` — let the caller handle the empty case.
    return opts.includeLocal && targetByLabel.size === 1 ? "local" : null;
  }
  if (!isInteractive()) return null;
  try {
    const picked = await selectSearch({
      message: opts.message ?? "Select a context for this repo",
      choices: labels,
      pageSize: 12,
    });
    return targetByLabel.get(picked) ?? null;
  } catch (err) {
    if (err instanceof ExitPromptError) throw err;
    return null;
  }
}

/** Resolves `org/workspace/project` slugs against the user's accessible context. */
export function resolveTriple(ctx: ContextResponse, target: string): ResolvedTriple | null {
  const parts = target.split("/");
  if (parts.length !== 3) return null;
  const [orgSlug, wsSlug, projSlug] = parts;
  const organization = ctx.organizations.find((o) => o.slug === orgSlug);
  if (!organization) return null;
  const workspace = ctx.workspaces.find(
    (w) => w.slug === wsSlug && w.organizationId === organization.id,
  );
  if (!workspace) return null;
  const project = ctx.projects.find(
    (p) => p.slug === projSlug && p.workspaceId === workspace.id,
  );
  if (!project) return null;
  return {
    organization: { id: organization.id, slug: organization.slug },
    workspace: { id: workspace.id, slug: workspace.slug },
    project: { id: project.id, slug: project.slug },
  };
}

function tripleLabel(ctx: ContextResponse, projectId: string): string | null {
  const project = ctx.projects.find((p) => p.id === projectId);
  if (!project) return null;
  const ws = ctx.workspaces.find((w) => w.id === project.workspaceId);
  const org = ctx.organizations.find((o) => o.id === project.organizationId);
  if (!ws || !org) return null;
  return `${org.slug}/${ws.slug}/${project.slug}`;
}

export async function runContextList(opts: { cwd?: string } = {}): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);
  const cfg = readCloudConfig(root);
  const session = authedClient();
  const activeCloud = isCloudActive(cfg);

  console.log(`  ${pc.bold("CONTEXT".padEnd(44))} STORAGE`);
  const mark = (active: boolean) => (active ? pc.green("*") : " ");
  console.log(`${mark(!activeCloud)} ${"local".padEnd(44)} ${pc.dim("~/.horus local Postgres")}`);

  if (!session) {
    console.log("");
    console.log(pc.dim(`Run ${pc.bold("horus login")} to see cloud contexts you can use.`));
    return 0;
  }

  try {
    const ctx = await session.client.context();
    for (const project of ctx.projects) {
      const label = tripleLabel(ctx, project.id);
      if (!label) continue;
      const active = activeCloud && cfg?.project?.id === project.id;
      console.log(`${mark(active)} ${label.padEnd(44)} ${pc.dim("Horus Cloud")}`);
    }
    console.log("");
    console.log(pc.dim("(* = active for this repo)"));
    return 0;
  } catch (err) {
    return reportCloudError(err);
  }
}

export async function runContextUse(
  target?: string,
  opts: { cwd?: string } = {},
): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);

  // No target given → pick from the accessible cloud contexts (plus `local`)
  // instead of erroring. Requires login + a TTY; otherwise ask for an explicit target.
  if (target === undefined || target === "") {
    const session = authedClient();
    if (!session) {
      console.error(
        pc.red(`Not logged in.`) +
          ` Run ${pc.bold("horus login")} first, or pass a target: ${pc.bold("horus context use local")}.`,
      );
      return 1;
    }
    let ctx: ContextResponse;
    try {
      ctx = await session.client.context();
    } catch (err) {
      return reportCloudError(err);
    }
    const picked = await pickContextTarget(ctx, { includeLocal: true });
    if (!picked) {
      console.error(
        pc.red("No context selected.") +
          `\n  Pass a target explicitly: ${pc.bold("horus context use local")} or ${pc.bold("horus context use <org>/<workspace>/<project>")}.` +
          `\n  Run ${pc.bold("horus context list")} to see what you can use.`,
      );
      return 1;
    }
    target = picked;
  }

  if (target === "local") {
    const cfg = readCloudConfig(root) ?? { context: "local" as const };
    writeCloudConfig(root, { ...cfg, context: "local" });
    console.log(
      `${pc.green("✓")} Context for this repo is now ${pc.bold("local")}. ` +
        pc.dim("(local data preserved)"),
    );
    return 0;
  }

  const session = authedClient();
  if (!session) {
    console.error(pc.red(`Not logged in. Run ${pc.bold("horus login")} first.`));
    return 1;
  }

  let ctx: ContextResponse;
  try {
    ctx = await session.client.context();
  } catch (err) {
    return reportCloudError(err);
  }

  const resolved = resolveTriple(ctx, target);
  if (!resolved) {
    console.error(
      pc.red(`You don't have access to ${pc.bold(target)}.`) +
        `\n  Ask an org admin for an invite, or run ${pc.bold("horus context list")} to see available projects.`,
    );
    return 1;
  }

  // A project IS the repository/codebase (HOR-280); we store the org/workspace/
  // project triple only — no separate Repository concept (HOR-278).
  writeCloudConfig(root, {
    context: "cloud",
    organization: resolved.organization,
    workspace: resolved.workspace,
    project: resolved.project,
  });
  console.log(
    `${pc.green("✓")} Context for this repo is now ${pc.bold(target)} ${pc.dim("(cloud)")}.`,
  );
  return 0;
}

/** A cloud project carries repo/sync metadata (HOR-277); render the set we have. */
type ProjectMeta = ContextResponse["projects"][number];

export function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Sync-metadata lines for a cloud project, shared by `context show` + `cloud status`. */
export function syncMetaLines(project: ProjectMeta): string[] {
  const lines: string[] = [];
  if (project.provider && project.provider !== "other") {
    lines.push(`${pc.bold("Provider:")}    ${project.provider}`);
  }
  if (project.remoteUrl) lines.push(`${pc.bold("Remote:")}      ${project.remoteUrl}`);
  if (project.defaultBranch) lines.push(`${pc.bold("Branch:")}      ${project.defaultBranch}`);
  const synced = formatRelativeTime(project.lastSyncedAt);
  lines.push(`${pc.bold("Last sync:")}   ${synced ?? pc.dim("never")}`);
  return lines;
}

/**
 * `horus context show` (HOR-278) — show the active context for this repo and, for
 * a cloud context, the selected project's sync metadata. The local config is a
 * convenience cache only; the server re-authorizes by ID on every request, so we
 * re-resolve the stored project against the live context and warn if it's no
 * longer accessible (stale config must never imply access).
 */
export async function runContextShow(opts: { cwd?: string } = {}): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);
  const cfg = readCloudConfig(root);

  if (!isCloudActive(cfg) || !cfg.project) {
    console.log(`${pc.bold("Context:")}    local`);
    console.log(`${pc.bold("Storage:")}    local Postgres ${pc.dim("(~/.horus)")}`);
    console.log(
      pc.dim(`Tip:        ${pc.bold("horus login")} then ${pc.bold("horus context use <org>/<workspace>/<project>")} to use a cloud project.`),
    );
    return 0;
  }

  const triple = `${cfg.organization?.slug}/${cfg.workspace?.slug}/${cfg.project.slug}`;
  console.log(`${pc.bold("Context:")}    ${triple}   ${pc.dim("(cloud)")}`);

  const session = authedClient();
  if (!session) {
    console.log(`${pc.bold("Account:")}    ${pc.dim("not logged in")}`);
    console.log(pc.dim(`Showing cached context. Run ${pc.bold("horus login")} for live project + sync details.`));
    return 0;
  }

  let ctx: ContextResponse;
  try {
    ctx = await session.client.context();
  } catch (err) {
    // Offline: the cached triple is still useful; the server stays the auth boundary.
    console.log(`${pc.bold("Account:")}    ${session.auth.account.email}`);
    if (err instanceof CloudOfflineError) {
      console.log(pc.dim("Offline — showing cached context; sync details unavailable."));
      return 0;
    }
    return reportCloudError(err);
  }

  const project = ctx.projects.find((p) => p.id === cfg.project?.id);
  if (!project) {
    // Stored ID resolves to nothing the caller can access → stale/lost-access config.
    console.log(`${pc.bold("Account:")}    ${session.auth.account.email}`);
    console.error(
      pc.yellow(`This repo's stored project is no longer in your accessible context.`) +
        `\n  Your access may have changed or the project was removed.` +
        `\n  Run ${pc.bold("horus context list")} to see available projects, then ${pc.bold("horus context use <org>/<workspace>/<project>")}.`,
    );
    return 1;
  }

  const ws = ctx.workspaces.find((w) => w.id === project.workspaceId);
  const org = ctx.organizations.find((o) => o.id === project.organizationId);
  console.log(
    `${pc.bold("Project:")}    ${project.name}` +
      (ws && org ? `  ·  workspace ${ws.name}  ·  org ${org.name}` : ""),
  );
  for (const line of syncMetaLines(project)) console.log(line);
  console.log(`${pc.bold("Account:")}    ${session.auth.account.email}`);
  console.log(`${pc.bold("Sync to:")}    ${triple} ${pc.dim("(horus cloud sync)")}`);
  return 0;
}

export function reportCloudError(err: unknown): number {
  if (err instanceof CloudOfflineError) {
    console.error(pc.red(err.message));
    return 1;
  }
  if (err instanceof CloudError && err.status === 401) {
    console.error(
      pc.red("Your session expired.") + ` Run ${pc.bold("horus login")} to continue. ` + pc.dim("(local mode still works)"),
    );
    return 1;
  }
  console.error(pc.red(`Cloud request failed: ${(err as Error).message}`));
  return 1;
}
