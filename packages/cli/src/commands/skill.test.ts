import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runSkillInstall,
  runSkillPrint,
  runSkillPath,
  generateSkillContent,
  getSkillInstallPath,
  getLegacyClaudeSkillPath,
  skillContentLeaksSecrets,
  SUPPORTED_TARGETS,
  type SkillTarget,
} from './skill.js';

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-skill-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function capture(
  fn: (write: (line: string) => void) => Promise<number>,
): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = [];
  return fn((line) => lines.push(line)).then((code) => ({ lines, code }));
}

// ---------------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------------

describe('generateSkillContent', () => {
  it('includes horus investigate command for all targets', () => {
    for (const target of SUPPORTED_TARGETS) {
      const content = generateSkillContent(target);
      expect(content).toContain('horus investigate');
    }
  });

  it('includes all required command recipes', () => {
    const content = generateSkillContent('generic');
    const required = [
      'horus init',
      'horus connect',
      'horus explain',
      'horus investigate',
      'horus queues',
      'horus logs',
      'horus state',
      'horus metrics',
      'horus changes',
      'horus replay',
      'horus ask',
      'horus postmortem',
      'horus owner',
      'horus score',
    ];
    for (const cmd of required) {
      expect(content, `missing: ${cmd}`).toContain(cmd);
    }
  });

  it('never references the removed setup/index commands', () => {
    const content = generateSkillContent('generic');
    expect(content).not.toMatch(/horus setup\b/);
    expect(content).not.toMatch(/horus index\b/);
  });

  it('documents the single onboarding command and idempotent re-runs', () => {
    const content = generateSkillContent('generic');
    expect(content).toContain('horus init');
    expect(content).toContain('idempotent');
  });

  it('distinguishes deterministic evidence from AI reasoning', () => {
    const content = generateSkillContent('generic');
    expect(content).toContain('not infallible');
    expect(content).toContain('Do not invent runtime evidence');
  });

  it('explains how to handle missing evidence', () => {
    const content = generateSkillContent('generic');
    expect(content).toContain('Horus returns nothing');
  });

  it('includes read-only safety note', () => {
    const content = generateSkillContent('generic');
    expect(content).toContain('read-only');
    expect(content).toContain('Never use Horus to mutate production');
  });

  it('includes hallucination warning', () => {
    const content = generateSkillContent('generic');
    expect(content).toContain('hallucinate');
  });

  it('includes logic and behavior question guidance', () => {
    const content = generateSkillContent('generic');
    expect(content).toContain('Logic and behavior questions');
    expect(content).toContain('horus ask <id>');
    expect(content).toContain('requires an investigation ID and a directive');
  });

  it('includes change and fix workflow', () => {
    const content = generateSkillContent('generic');
    expect(content).toContain('Change and fix workflow');
    expect(content).toContain('blast radius');
  });

  it('claude target includes skill frontmatter and native path', () => {
    const content = generateSkillContent('claude');
    expect(content).toContain('name: horus');
    expect(content).toContain('.claude/skills/horus/SKILL.md');
  });

  it('gemini target has no frontmatter and references GEMINI.md', () => {
    const content = generateSkillContent('gemini');
    expect(content).not.toContain('name: horus');
    expect(content).toContain('GEMINI.md');
    expect(content).toContain('Gemini CLI');
  });

  it('cursor target includes mdc frontmatter and native path', () => {
    const content = generateSkillContent('cursor');
    expect(content).toContain('globs: *');
    expect(content).toContain('alwaysApply: true');
    expect(content).toContain('.cursor/rules/horus.mdc');
  });

  it('codex target has no frontmatter and includes codex note', () => {
    const content = generateSkillContent('codex');
    expect(content).not.toContain('name: horus');
    expect(content).toContain('Codex CLI');
    expect(content).toContain('AGENTS.md');
  });

  it('generic target has no frontmatter', () => {
    const content = generateSkillContent('generic');
    expect(content).not.toContain('name: horus');
    expect(content).not.toContain('---');
  });

  it('non-claude targets do not include claude-specific path', () => {
    for (const target of SUPPORTED_TARGETS.filter((t) => t !== 'claude')) {
      const content = generateSkillContent(target);
      expect(content).not.toContain('.claude/skills');
    }
  });
});

// ---------------------------------------------------------------------------
// Install paths
// ---------------------------------------------------------------------------

const LOCAL_PATHS: Record<SkillTarget, string> = {
  claude: '.claude/skills/horus/SKILL.md',
  gemini: 'GEMINI.md',
  cursor: '.cursor/rules/horus.mdc',
  codex: 'AGENTS.md',
  generic: '.horus/skills/horus-generic.md',
};

describe('getSkillInstallPath', () => {
  for (const target of SUPPORTED_TARGETS) {
    it(`${target} → ${LOCAL_PATHS[target]} under cwd`, () => {
      const p = getSkillInstallPath(target, { cwd: '/projects/my-app' });
      expect(p).toBe(`/projects/my-app/${LOCAL_PATHS[target]}`);
    });
  }

  it('claude --global → .claude/skills/horus/SKILL.md under home', () => {
    const p = getSkillInstallPath('claude', { global: true });
    expect(p).toContain('.claude/skills/horus/SKILL.md');
    expect(p).not.toContain('/projects');
  });

  it('gemini --global → .gemini/GEMINI.md under home', () => {
    const p = getSkillInstallPath('gemini', { global: true });
    expect(p).toContain('.gemini/GEMINI.md');
    expect(p).not.toContain('/projects');
  });

  it('cursor --global → .cursorrules under home', () => {
    const p = getSkillInstallPath('cursor', { global: true });
    expect(p).toContain('.cursorrules');
    expect(p).not.toContain('/projects');
  });

  it('codex --global → .codex/AGENTS.md under home', () => {
    const p = getSkillInstallPath('codex', { global: true });
    expect(p).toContain('.codex/AGENTS.md');
    expect(p).not.toContain('/projects');
  });
});

describe('getLegacyClaudeSkillPath', () => {
  it('returns the old flat horus.md path under cwd', () => {
    const p = getLegacyClaudeSkillPath({ cwd: '/projects/my-app' });
    expect(p).toBe('/projects/my-app/.claude/skills/horus.md');
  });
});

// ---------------------------------------------------------------------------
// runSkillInstall
// ---------------------------------------------------------------------------

describe('runSkillInstall — success', () => {
  for (const target of SUPPORTED_TARGETS) {
    it(`exits 0 and creates the skill for ${target} target`, async () => {
      const dir = tempDir();
      const code = await runSkillInstall(target, { cwd: dir, write: () => {} });
      expect(code).toBe(0);
      expect(existsSync(getSkillInstallPath(target, { cwd: dir }))).toBe(true);
    });
  }

  it('written content matches generated content', async () => {
    const dir = tempDir();
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    const outPath = getSkillInstallPath('generic', { cwd: dir });
    const content = readFileSync(outPath, 'utf8');
    expect(content).toBe(generateSkillContent('generic'));
  });

  it('prints the install path in the success message', async () => {
    const dir = tempDir();
    const { lines, code } = await capture((write) =>
      runSkillInstall('generic', { cwd: dir, write }),
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('.horus/skills');
  });
});

describe('runSkillInstall — overwrite protection', () => {
  it('exits 1 and refuses to overwrite without --force', async () => {
    const dir = tempDir();
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    const code = await runSkillInstall('generic', { cwd: dir, write: () => {} });
    expect(code).toBe(1);
  });

  it('preserves existing content without --force', async () => {
    const dir = tempDir();
    const outPath = getSkillInstallPath('generic', { cwd: dir });
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    writeFileSync(outPath, 'custom content', 'utf8');
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    expect(readFileSync(outPath, 'utf8')).toBe('custom content');
  });

  it('mentions --force in refusal message', async () => {
    const dir = tempDir();
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    const { lines } = await capture((write) =>
      runSkillInstall('generic', { cwd: dir, write }),
    );
    expect(lines.join('\n')).toContain('--force');
  });

  it('exits 0 and overwrites with --force', async () => {
    const dir = tempDir();
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    const outPath = getSkillInstallPath('generic', { cwd: dir });
    writeFileSync(outPath, 'old content', 'utf8');
    const code = await runSkillInstall('generic', { cwd: dir, force: true, write: () => {} });
    expect(code).toBe(0);
    expect(readFileSync(outPath, 'utf8')).not.toBe('old content');
  });

  it('protects existing claude directory SKILL.md without --force', async () => {
    const dir = tempDir();
    const outPath = getSkillInstallPath('claude', { cwd: dir });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, 'existing skill', 'utf8');
    const code = await runSkillInstall('claude', { cwd: dir, write: () => {} });
    expect(code).toBe(1);
    expect(readFileSync(outPath, 'utf8')).toBe('existing skill');
  });

  it('overwrites existing claude directory SKILL.md with --force', async () => {
    const dir = tempDir();
    const outPath = getSkillInstallPath('claude', { cwd: dir });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, 'existing skill', 'utf8');
    const code = await runSkillInstall('claude', { cwd: dir, force: true, write: () => {} });
    expect(code).toBe(0);
    expect(readFileSync(outPath, 'utf8')).not.toBe('existing skill');
  });
});

describe('runSkillInstall — legacy flat claude migration', () => {
  it('migrates old flat horus.md to directory layout when confirmed', async () => {
    const dir = tempDir();
    const legacyPath = getLegacyClaudeSkillPath({ cwd: dir });
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, 'old flat skill', 'utf8');

    const code = await runSkillInstall('claude', {
      cwd: dir,
      write: () => {},
      confirm: async () => true,
    });

    expect(code).toBe(0);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(getSkillInstallPath('claude', { cwd: dir }))).toBe(true);
  });

  it('cancels migration when user declines confirmation', async () => {
    const dir = tempDir();
    const legacyPath = getLegacyClaudeSkillPath({ cwd: dir });
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, 'old flat skill', 'utf8');

    const code = await runSkillInstall('claude', {
      cwd: dir,
      write: () => {},
      confirm: async () => false,
    });

    expect(code).toBe(1);
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(getSkillInstallPath('claude', { cwd: dir }))).toBe(false);
  });

  it('migrates old flat horus.md without prompting when --force is passed', async () => {
    const dir = tempDir();
    const legacyPath = getLegacyClaudeSkillPath({ cwd: dir });
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, 'old flat skill', 'utf8');

    const code = await runSkillInstall('claude', {
      cwd: dir,
      force: true,
      write: () => {},
    });

    expect(code).toBe(0);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(getSkillInstallPath('claude', { cwd: dir }))).toBe(true);
  });
});

describe('runSkillInstall — unknown target', () => {
  it('exits 1 for an unknown target', async () => {
    const dir = tempDir();
    const code = await runSkillInstall('unknown-agent', { cwd: dir, write: () => {} });
    expect(code).toBe(1);
  });

  it('lists supported targets in the error message', async () => {
    const dir = tempDir();
    const { lines } = await capture((write) =>
      runSkillInstall('unknown-agent', { cwd: dir, write }),
    );
    expect(lines.join('\n')).toContain('claude');
    expect(lines.join('\n')).toContain('generic');
  });
});

// ---------------------------------------------------------------------------
// runSkillPath
// ---------------------------------------------------------------------------

describe('runSkillPath', () => {
  for (const target of SUPPORTED_TARGETS) {
    it(`prints the ${target} install path and exits 0`, async () => {
      const dir = tempDir();
      const { lines, code } = await capture((write) =>
        runSkillPath(target, { cwd: dir, write }),
      );
      expect(code).toBe(0);
      expect(lines[0]).toContain(LOCAL_PATHS[target]);
    });
  }

  it('exits 1 for an unknown target', async () => {
    const dir = tempDir();
    const code = await runSkillPath('unknown', { cwd: dir, write: () => {} });
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// No secret leakage
// ---------------------------------------------------------------------------

describe('skillContentLeaksSecrets', () => {
  it('returns false for normal skill content', () => {
    for (const target of SUPPORTED_TARGETS) {
      expect(skillContentLeaksSecrets(generateSkillContent(target))).toBe(false);
    }
  });

  it('returns true when content contains a password field', () => {
    expect(skillContentLeaksSecrets('"password": "hunter2"')).toBe(true);
  });

  it('returns true when content contains an apiKey field', () => {
    expect(skillContentLeaksSecrets('"apiKey": "sk-abc123def456"')).toBe(true);
  });

  it('returns true when content contains a MongoDB URI with credentials', () => {
    expect(
      skillContentLeaksSecrets('mongodb+srv://user:pass@cluster.mongodb.net/db'),
    ).toBe(true);
  });
});
