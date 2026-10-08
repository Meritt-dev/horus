import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin, runLogout } from "./login.js";
import { runContextList, runContextUse, runContextShow } from "./context.js";
import { runCloudLink, runCloudUnlink, runCloudStatus } from "./cloud.js";

const API = "https://api.test";

// Minimal fake of the HOR-224 cloud API, routed by path suffix.
function fakeFetch() {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const method = init?.method ?? "GET";
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;

    if (u.endsWith("/v1/me")) {
      if (auth !== "Bearer good-token") return json({ error: { code: "invalid_token", message: "bad" } }, 401);
      return json({
        user: { id: "u1", primaryEmail: "dev@meritt.dev", displayName: "Dev" },
        memberships: [{ organizationId: "o1", role: "owner", workspaceIds: ["w1"] }],
      });
    }
    if (u.endsWith("/v1/context")) {
      return json({
        user: { id: "u1", primaryEmail: "dev@meritt.dev" },
        organizations: [{ id: "o1", slug: "meritt-dev", name: "Meritt Dev", role: "owner" }],
        workspaces: [{ id: "w1", slug: "internal-products", name: "Internal Products", organizationId: "o1" }],
        projects: [{
          id: "p1",
          slug: "horus",
          name: "Horus",
          workspaceId: "w1",
          organizationId: "o1",
          provider: "github",
          remoteUrl: "https://github.com/meritt-dev/horus",
          defaultBranch: "main",
          lastSeenCommit: "abc1234",
          lastSyncedAt: "2026-06-19T09:00:00.000Z",
        }],
      });
    }
    if (u.endsWith("/v1/cli/tokens") && method === "GET") {
      return json({ tokens: [{ id: "t1", name: "cli", prefix: "good-token".slice(0, 12), lastUsedAt: null, expiresAt: null, revokedAt: null, createdAt: "x" }] });
    }
    if (u.includes("/v1/cli/tokens/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (u.includes("/repositories") && method === "POST") {
      return new Response(null, { status: 404 }); // endpoint not implemented yet
    }
    return json({ error: { code: "not_found", message: "no route" } }, 404);
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let home: string;
let repo: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "horus-home-"));
  repo = mkdtempSync(join(tmpdir(), "horus-repo-"));
  process.env.HORUS_HOME = home;
  vi.stubEnv('HORUS_DB_DIR', home);
  process.env.HORUS_CLOUD_API_URL = API;
  delete process.env.HORUS_TOKEN;
  vi.stubGlobal("fetch", fakeFetch());
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  delete process.env.HORUS_HOME;
  delete process.env.HORUS_CLOUD_API_URL;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("HOR-226 CLI cloud commands", () => {
  it("login stores a token after validating it, rejects a bad one", async () => {
    expect(await runLogin({ token: "bad", apiUrl: API })).toBe(1);
    expect(existsSync(join(home, "auth.json"))).toBe(false);

    expect(await runLogin({ token: "good-token", apiUrl: API })).toBe(0);
    const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    expect(auth.token).toBe("good-token");
    expect(auth.account.email).toBe("dev@meritt.dev");
  });

  it("context use switches to a cloud project and back to local", async () => {
    await runLogin({ token: "good-token", apiUrl: API });

    expect(await runContextUse("meritt-dev/internal-products/horus", { cwd: repo })).toBe(0);
    const cfg = JSON.parse(readFileSync(join(repo, ".horus", "cloud.json"), "utf8"));
    expect(cfg.context).toBe("cloud");
    expect(cfg.project).toEqual({ id: "p1", slug: "horus" });

    expect(await runContextUse("local", { cwd: repo })).toBe(0);
    const local = JSON.parse(readFileSync(join(repo, ".horus", "cloud.json"), "utf8"));
    expect(local.context).toBe("local");
  });

  it("rejects a context the user can't access", async () => {
    await runLogin({ token: "good-token", apiUrl: API });
    expect(await runContextUse("acme/secret/thing", { cwd: repo })).toBe(1);
    expect(existsSync(join(repo, ".horus", "cloud.json"))).toBe(false);
  });

  it("requires login before using a cloud context", async () => {
    expect(await runContextUse("meritt-dev/internal-products/horus", { cwd: repo })).toBe(1);
  });

  it("cloud link writes the project binding with no separate Repository (HOR-278)", async () => {
    await runLogin({ token: "good-token", apiUrl: API });
    expect(await runCloudLink({ project: "meritt-dev/internal-products/horus", yes: true, cwd: repo })).toBe(0);
    const cfg = JSON.parse(readFileSync(join(repo, ".horus", "cloud.json"), "utf8"));
    expect(cfg.context).toBe("cloud");
    expect(cfg.project).toEqual({ id: "p1", slug: "horus" });
    // A project IS the repository now — the link no longer stores a Repository ref.
    expect(cfg.repository).toBeUndefined();
  });

  it("context show reports local mode without a network call", async () => {
    expect(await runContextShow({ cwd: repo })).toBe(0);
  });

  it("context show renders the cloud project + sync metadata", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runLogin({ token: "good-token", apiUrl: API });
    await runContextUse("meritt-dev/internal-products/horus", { cwd: repo });
    expect(await runContextShow({ cwd: repo })).toBe(0);
    const out = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(out).toContain("meritt-dev/internal-products/horus");
    expect(out).toContain("github");
    expect(out).toContain("main");
    expect(out).toContain("https://github.com/meritt-dev/horus");
  });

  it("context show flags a stale config whose project is no longer accessible", async () => {
    await runLogin({ token: "good-token", apiUrl: API });
    await runContextUse("meritt-dev/internal-products/horus", { cwd: repo });
    // Simulate lost access: rewrite the stored project to one not in the live context.
    const cfgPath = join(repo, ".horus", "cloud.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.project = { id: "p-gone", slug: "horus" };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    expect(await runContextShow({ cwd: repo })).toBe(1);
  });

  it("cloud status returns 0 in both local and cloud modes", async () => {
    expect(await runCloudStatus({ cwd: repo })).toBe(0); // local
    await runLogin({ token: "good-token", apiUrl: API });
    await runContextUse("meritt-dev/internal-products/horus", { cwd: repo });
    expect(await runCloudStatus({ cwd: repo })).toBe(0); // cloud
  });

  it("cloud unlink returns the repo to local", async () => {
    await runLogin({ token: "good-token", apiUrl: API });
    await runCloudLink({ project: "meritt-dev/internal-products/horus", yes: true, cwd: repo });
    expect(await runCloudUnlink({ cwd: repo })).toBe(0);
    expect(existsSync(join(repo, ".horus", "cloud.json"))).toBe(false);
  });

  it("context list runs logged-out (local only) and logged-in", async () => {
    expect(await runContextList({ cwd: repo })).toBe(0);
    await runLogin({ token: "good-token", apiUrl: API });
    expect(await runContextList({ cwd: repo })).toBe(0);
  });

  it("logout revokes the token and clears local creds", async () => {
    await runLogin({ token: "good-token", apiUrl: API });
    expect(existsSync(join(home, "auth.json"))).toBe(true);
    expect(await runLogout()).toBe(0);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });
});
