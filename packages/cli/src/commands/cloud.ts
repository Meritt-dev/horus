/**
 * `horus cloud link` / `unlink` / `status` (HOR-226, per HOR-225).
 *
 * Links the current repo to a cloud project so investigations are stored in
 * Horus Cloud. Git remote detection is a discovery aid only (HOR-238 §7); the
 * `.horus/cloud.json` binding is authoritative and carries no secrets.
 */
import pc from "picocolors";
import { loadConfig, resolveEnvironment } from '@horus/core';
import { createInterface } from "node:readline/promises";
import type { ContextResponse, CloudClient } from "../lib/cloud/api.js";
import {
  readCloudConfig,
  writeCloudConfig,
  clearCloudConfig,
  isCloudActive,
} from "../lib/cloud/context-store.js";
import {
  detectGitRemote,
  remotesMatch,
  inferProvider,
  parseRepoName,
  type GitRemote,
} from "../lib/cloud/git.js";
import { authedClient, repoRootOrCwd } from "../lib/cloud/session.js";
import { resolveTriple, reportCloudError, syncMetaLines, pickContextTarget } from "./context.js";
import { openDb, listInvestigationsWithReports } from "@horus/db";
import type { InvestigationReport } from "@horus/engine";
import { uploadInvestigationToCloud } from "../lib/cloud/investigation-sync.js";

export async function runCloudLink(
  opts: { project?: string; yes?: boolean; cwd?: string } = {},
): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);
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

  const remote = detectGitRemote(root);
  if (remote) console.log(pc.dim(`Detected git remote: ${remote.remoteUrl}`));

  // Resolve the target project, in order of preference:
  //   1. explicit <org/workspace/project> argument
  //   2. existing cloud binding for this repo
  //   3. AUTO-MATCH: a cloud project whose remoteUrl matches this git remote
  //   4. CREATE-FROM-REPO: interactively create a project from this repo
  let resolved: ReturnType<typeof resolveTriple> | null = null;
  let target = opts.project;
  if (!target) {
    const existing = readCloudConfig(root);
    if (isCloudActive(existing) && existing?.organization && existing?.workspace && existing?.project) {
      target = `${existing.organization.slug}/${existing.workspace.slug}/${existing.project.slug}`;
    }
  }

  // 3. Auto-match by git remote — link with no flag when a project already maps
  // to this repository (HOR-307).
  if (!target && remote) {
    const match = ctx.projects.find((p) => p.remoteUrl && remotesMatch(p.remoteUrl, remote.remoteUrl));
    if (match) {
      const ws = ctx.workspaces.find((w) => w.id === match.workspaceId);
      const org = ctx.organizations.find((o) => o.id === match.organizationId);
      if (ws && org) {
        target = `${org.slug}/${ws.slug}/${match.slug}`;
        console.log(pc.dim(`Matched existing project by remote: ${pc.bold(target)}`));
      }
    }
  }

  // 4. Nothing auto-matched — let the user PICK from their accessible projects
  // (no slug typing) before falling back to creating one. Skipped with -y/--yes
  // (non-interactive) and when there are no accessible projects.
  if (!target && !opts.yes && ctx.projects.length > 0) {
    const picked = await pickContextTarget(ctx, {
      message: "Link this repo to which cloud project?",
    });
    if (picked && picked !== "local") target = picked;
  }

  // 5. Still nothing — offer to create a project from this repo.
  if (!target) {
    const created = await createProjectFromRepo(session.client, ctx, remote, opts.yes);
    if (created === "aborted") return 1;
    if (!created) {
      console.error(
        pc.red("No project to link.") +
          `\n  Run ${pc.bold("horus cloud link")} in a TTY to pick or create one, pass a target (${pc.bold("horus cloud link <org/workspace/project>")}), ` +
          `or create a project at ${pc.bold("https://cloud.horus.sh")}.`,
      );
      return 1;
    }
    resolved = created;
  }

  // Resolve the slug triple (flag / binding / auto-match paths).
  if (!resolved) {
    resolved = resolveTriple(ctx, target!);
    if (!resolved) {
      console.error(
        pc.red(`You don't have access to ${pc.bold(target!)}.`) +
          `\n  Run ${pc.bold("horus context list")} to see available projects.`,
      );
      return 1;
    }
  }

  const label = `${resolved.organization.slug}/${resolved.workspace.slug}/${resolved.project.slug}`;

  // A project IS the repository/codebase (HOR-280); the link stores the
  // org/workspace/project triple only — no separate Repository concept (HOR-278).
  writeCloudConfig(root, {
    context: "cloud",
    organization: resolved.organization,
    workspace: resolved.workspace,
    project: resolved.project,
  });

  console.log(
    `${pc.green("✓")} Linked. Context for this repo is now ${pc.bold(label)} ${pc.dim("(cloud)")}.`,
  );
  console.log(
    pc.dim(`  Investigations here save to Horus Cloud. ${pc.bold("horus context use local")} to switch back.`),
  );
  return 0;
}

export async function runCloudUnlink(opts: { cwd?: string } = {}): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);
  const cfg = readCloudConfig(root);
  if (!cfg || cfg.context !== "cloud") {
    console.log(pc.dim("This repo isn't linked to a cloud project."));
    return 0;
  }
  clearCloudConfig(root);
  console.log(`${pc.green("✓")} Unlinked. This repo is back to ${pc.bold("local")} mode.`);
  return 0;
}

export async function runCloudStatus(opts: { cwd?: string } = {}): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);
  const cfg = readCloudConfig(root);
  const session = authedClient();

  if (!isCloudActive(cfg) || !cfg?.project) {
    console.log(`${pc.bold("Context:")}  local`);
    console.log(`${pc.bold("Storage:")}  local Postgres (~/.horus)`);
    console.log(
      pc.dim(`Tip:      ${pc.bold("horus login")} then ${pc.bold("horus cloud link")} to share investigations with your team.`),
    );
    return 0;
  }

  const triple = `${cfg.organization?.slug}/${cfg.workspace?.slug}/${cfg.project.slug}`;
  console.log(`${pc.bold("Context:")}     ${triple}   ${pc.dim("(cloud)")}`);

  // Enrich with the project's name + repo/sync metadata when logged in + online;
  // fall back to the cached slug otherwise. A project IS the repository (HOR-280),
  // so there is no separate Repository line (HOR-278).
  let projectLine = `${cfg.project.slug}`;
  let metaLines: string[] = [];
  let account = pc.dim("not logged in");
  if (session) {
    account = session.auth.account.email;
    try {
      const ctx = await session.client.context();
      const project = ctx.projects.find((p) => p.id === cfg.project?.id);
      const ws = ctx.workspaces.find((w) => w.id === project?.workspaceId);
      const org = ctx.organizations.find((o) => o.id === project?.organizationId);
      if (project && ws && org) {
        projectLine = `${project.name}  ·  workspace ${ws.name}  ·  org ${org.name}`;
        metaLines = syncMetaLines(project);
      }
    } catch {
      // offline — keep slug-only line, no metadata
    }
  }
  console.log(`${pc.bold("Project:")}     ${projectLine}`);
  for (const line of metaLines) console.log(line);
  console.log(`${pc.bold("Account:")}     ${account}`);
  return 0;
}

/**
 * `horus cloud sync` (HOR-240) — upload existing LOCAL investigation history to
 * the linked cloud project, through the cloud API (never the cloud DB). Only
 * investigations that have a stored report are uploadable. Retries are safe:
 * `uploadInvestigationToCloud` carries report-id-derived idempotency keys, so the
 * server dedupes. Local data is never modified.
 */
export async function runCloudSync(
  opts: { config?: string; cwd?: string; yes?: boolean; dryRun?: boolean; limit?: number } = {},
): Promise<number> {
  const root = repoRootOrCwd(opts.cwd);
  const cfg = readCloudConfig(root);
  if (!isCloudActive(cfg) || !cfg.project) {
    console.error(
      pc.red("This repo isn't linked to a cloud project.") +
        ` Run ${pc.bold("horus cloud link")} first.`,
    );
    return 1;
  }
  const session = authedClient();
  if (!session) {
    console.error(pc.red(`Not logged in. Run ${pc.bold("horus login")} first.`));
    return 1;
  }

  // Source: local investigations that carry a stored report (others can't be uploaded). The db
  // stays open through the upload loop so each investigation's human outcome label (HOR-390 eval
  // store) can ride its sync; closed once in the finally below.
  // Push ONLY this project's investigations — an unscoped read uploaded every local
  // project's incidents to this repo's cloud team (dogfood N1).
  let project: string | undefined;
  try {
    project = resolveEnvironment(await loadConfig(opts.config)).project;
  } catch {
    /* unresolvable — leave unscoped */
  }
  const { db, sql } = await openDb();
  try {
    const uploadable: { id: string; title: string | null; report: InvestigationReport }[] = [];
    let skippedNoReport = 0;
    const rows = await listInvestigationsWithReports(db, opts.limit ?? 1000, { project });
    for (const row of rows) {
      if (row.report && typeof row.report === "object") {
        uploadable.push({ id: row.id, title: row.title, report: row.report as InvestigationReport });
      } else {
        skippedNoReport++;
      }
    }

    const target = `${cfg.organization?.slug}/${cfg.workspace?.slug}/${cfg.project.slug}`;

    if (uploadable.length === 0) {
      console.log(
        pc.dim(
          `No local investigations with reports to upload.` +
            (skippedNoReport ? ` (${skippedNoReport} without a report skipped)` : ""),
        ),
      );
      return 0;
    }

    // Preview what will be uploaded (HOR-240: show before migrating).
    console.log(pc.bold(`Will upload ${uploadable.length} investigation(s) to ${target} ${pc.dim("(cloud)")}:`));
    for (const c of uploadable.slice(0, 20)) {
      console.log(`  ${pc.dim(c.id.slice(0, 8))}  ${(c.title ?? "untitled").slice(0, 70)}`);
    }
    if (uploadable.length > 20) console.log(pc.dim(`  …and ${uploadable.length - 20} more`));
    if (skippedNoReport) console.log(pc.dim(`  (${skippedNoReport} local investigation(s) without a report will be skipped)`));

    if (opts.dryRun) {
      console.log(pc.dim("Dry run — nothing uploaded. Re-run without --dry-run to upload."));
      return 0;
    }

    // Confirm unless --yes. Non-interactive without --yes is treated as a safe stop.
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        console.error(
          pc.yellow(`Re-run with ${pc.bold("--yes")} to upload, or ${pc.bold("--dry-run")} to preview only.`),
        );
        return 1;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(`Upload ${uploadable.length} investigation(s) to ${target}? (y/N) `))
          .trim()
          .toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          console.log(pc.dim("Aborted. Nothing uploaded."));
          return 0;
        }
      } finally {
        rl.close();
      }
    }

    let created = 0;
    let failed = 0;
    for (const c of uploadable) {
      try {
        const refs = await uploadInvestigationToCloud(session.client, cfg, c.report, { db });
        created++;
        console.log(`${pc.green("✓")} ${pc.dim(c.id.slice(0, 8))} → ${refs.investigationId}`);
      } catch (err) {
        failed++;
        console.error(`${pc.red("✗")} ${pc.dim(c.id.slice(0, 8))} ${(err as Error).message}`);
      }
    }

    console.log("");
    console.log(
      `${pc.bold("Sync complete:")} ${pc.green(`${created} uploaded`)}, ${skippedNoReport} skipped, ` +
        (failed ? pc.red(`${failed} failed`) : "0 failed") + ".",
    );
    console.log(
      pc.dim("Local data was not modified. Re-running is safe — duplicates are deduped by idempotency key."),
    );
    return failed > 0 ? 1 : 0;
  } finally {
    await sql.end();
  }
}

interface LinkTriple {
  organization: { id: string; slug: string };
  workspace: { id: string; slug: string };
  project: { id: string; slug: string };
}

/**
 * Interactive create-from-repo (HOR-307). When no project matches the repo, walk
 * the user through choosing an org + workspace (or creating one) and naming the
 * project (defaulting to the repo name), then create it with the repo's remote so
 * a future `cloud link` auto-matches. Returns the new triple, null (non-TTY / no
 * org), or "aborted" when the user declines.
 */
async function createProjectFromRepo(
  client: CloudClient,
  ctx: ContextResponse,
  remote: GitRemote | null,
  yes?: boolean,
): Promise<LinkTriple | null | "aborted"> {
  if (!process.stdin.isTTY && !yes) return null;
  if (ctx.organizations.length === 0) {
    console.error(
      pc.red("You're not a member of any organization yet.") +
        `\n  Create one at ${pc.bold("https://cloud.horus.sh")} first.`,
    );
    return null;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def?: string): Promise<string> => {
    if (yes && def !== undefined) return def;
    const a = (await rl.question(def ? `${q} (${def}): ` : `${q}: `)).trim();
    return a || def || "";
  };

  try {
    // Org — auto-select when there's only one. (Length ≥ 1 checked above.)
    let org = ctx.organizations[0]!;
    if (ctx.organizations.length > 1) {
      console.log("Organizations:");
      ctx.organizations.forEach((o, i) => console.log(`  ${i + 1}) ${o.slug}`));
      const idx = Number(await ask("Org number", "1")) - 1;
      org = ctx.organizations[idx] ?? org;
    }

    // Workspace — pick an existing one in this org or create a new one.
    const orgWorkspaces = ctx.workspaces.filter((w) => w.organizationId === org.id);
    let workspace: { id: string; slug: string };
    const repoName = remote ? parseRepoName(remote.remoteUrl) : "";
    if (orgWorkspaces.length === 0) {
      const wsName = await ask("New workspace name", repoName || "default");
      const ws = await client.createWorkspace(org.id, { name: wsName });
      workspace = { id: ws.id, slug: ws.slug };
      console.log(pc.dim(`Created workspace ${pc.bold(ws.slug)}.`));
    } else {
      console.log(`Workspaces in ${pc.bold(org.slug)}:`);
      orgWorkspaces.forEach((w, i) => console.log(`  ${i + 1}) ${w.slug}`));
      console.log(`  ${orgWorkspaces.length + 1}) + create a new workspace`);
      const pick = Number(await ask("Workspace number", "1"));
      if (pick === orgWorkspaces.length + 1) {
        const wsName = await ask("New workspace name", repoName || "default");
        const ws = await client.createWorkspace(org.id, { name: wsName });
        workspace = { id: ws.id, slug: ws.slug };
        console.log(pc.dim(`Created workspace ${pc.bold(ws.slug)}.`));
      } else {
        const chosen = orgWorkspaces[pick - 1] ?? orgWorkspaces[0]!;
        workspace = { id: chosen.id, slug: chosen.slug };
      }
    }

    // Project — default the name to the repo name.
    const projName = await ask("Project name", repoName || "project");
    const project = await client.createProject(org.id, workspace.id, {
      name: projName,
      remoteUrl: remote?.remoteUrl,
      provider: remote ? inferProvider(remote.remoteUrl) : undefined,
    });
    console.log(pc.dim(`Created project ${pc.bold(project.slug)}.`));

    return {
      organization: { id: org.id, slug: org.slug },
      workspace,
      project: { id: project.id, slug: project.slug },
    };
  } catch (err) {
    reportCloudError(err);
    return "aborted";
  } finally {
    rl.close();
  }
}
