import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';

export const SUPPORTED_TARGETS = ['claude', 'codex', 'gemini', 'cursor', 'generic'] as const;
export type SkillTarget = (typeof SUPPORTED_TARGETS)[number];

export function isValidTarget(target: string): target is SkillTarget {
  return (SUPPORTED_TARGETS as readonly string[]).includes(target);
}

/** Legacy flat-file path used by early Horus Claude skill installers. */
export function getLegacyClaudeSkillPath(opts: { global?: boolean; cwd?: string }): string {
  const base = opts.global ? homedir() : (opts.cwd ?? process.cwd());
  return join(base, '.claude', 'skills', 'horus.md');
}

export function getSkillInstallPath(
  target: SkillTarget,
  opts: { global?: boolean; cwd?: string },
): string {
  const base = opts.global ? homedir() : (opts.cwd ?? process.cwd());
  switch (target) {
    case 'claude':
      return join(base, '.claude', 'skills', 'horus', 'SKILL.md');
    case 'gemini':
      return opts.global ? join(base, '.gemini', 'GEMINI.md') : join(base, 'GEMINI.md');
    case 'cursor':
      return opts.global
        ? join(base, '.cursorrules')
        : join(base, '.cursor', 'rules', 'horus.mdc');
    case 'codex':
      return opts.global ? join(base, '.codex', 'AGENTS.md') : join(base, 'AGENTS.md');
    case 'generic':
    default:
      return join(base, '.horus', 'skills', `horus-${target}.md`);
  }
}

const BASE_SKILL = `\
# Horus Grounded Investigation Skill

When working in a repo with Horus configured, use Horus before guessing about production behavior, runtime state, ownership, recent changes, or codebase logic.

Horus is a read-only evidence layer. It helps collect and connect source, runtime, metrics, queue, log, ownership, and change evidence. It does not mutate production systems.

## When to use Horus

Use Horus when the user asks:

* why something is broken, slow, failing, flaky, or inconsistent
* about a production incident, outage, regression, or degraded service
* what changed recently
* what caused a behavior change
* who owns a component, service, queue, worker, route, or module
* about blast radius or impact of a change
* about queues, workers, Redis, BullMQ, NATS, logs, metrics, MongoDB state, or source paths
* to verify a fix or check for regressions after a change
* whether a feature behaves a certain way
* where business logic lives
* whether a condition, flag, enum, status, or branch is handled
* whether code paths are connected or only coincidentally similar

## Setup (once per repo)

If the repo has no \`.horus/config.json\` yet (or \`horus doctor\` shows source
intelligence missing), run the single onboarding command:

\`\`\`bash
horus init
\`\`\`

It checks prerequisites, writes and registers the config, starts the
source-intelligence host, indexes the code, and stitches the queue map.
Re-running it is safe (idempotent — reuses a healthy host, refreshes the index).
Add runtime evidence sources with \`horus connect <type>\` (credentials are
encrypted; never hand-edit them into config). The source backend ships inside
the Horus bundle — \`horus init\` installs it automatically if missing.

## Default first steps

Start small. Do not shotgun every command.

\`\`\`bash
horus status
horus investigate "<incident, behavior, or debugging hint>"
\`\`\`

If Horus returns a saved investigation ID, use that ID for follow-up reasoning:

\`\`\`bash
horus ask <id> "what evidence is missing?"
horus ask <id> "what evidence contradicts the likely root cause?"
horus score <id>
\`\`\`

## Report whether Horus helped (close the loop)

Once you have **acted on an investigation and know the outcome** — you verified
whether Horus pointed at the real cause — record it. This is how Horus measures and
improves its own accuracy, and without it the impact signal is blind to agent-driven
runs (most of them).

\`\`\`bash
horus feedback <id> --resolved yes      # Horus pointed at the real cause
horus feedback <id> --resolved partly   # useful lead, but not the whole cause
horus feedback <id> --resolved no       # Horus missed the cause
\`\`\`

It is non-interactive and safe to run unattended. Report **once** per investigation,
**after** you confirm the outcome — never before, and never guess. If you can estimate
how long the same debugging would have taken you manually, add it:

\`\`\`bash
horus feedback <id> --resolved yes --manual-estimate-min 120
\`\`\`

## Runtime evidence

Use runtime commands when the question depends on live or recent runtime behavior:

\`\`\`bash
horus logs [service]
horus state
horus metrics "<hint>"
horus queues --live
\`\`\`

Examples:

\`\`\`bash
horus logs api
horus metrics "checkout latency"
horus queues --live
horus state
\`\`\`

## Source reasoning

Use source commands when the question depends on code behavior, ownership, blast radius, or recent code changes:

\`\`\`bash
horus explain <symbol-or-hint>
horus blast-radius <symbol>
horus owner <symbol>
horus changes <base> [compare]
horus timeline
horus what-changed
\`\`\`

Examples:

\`\`\`bash
horus explain "brandType MANUAL product auto draft"
horus blast-radius ProductDraftService
horus owner ProductDraftService
horus what-changed
\`\`\`

## Logic and behavior questions

For questions like:

* "Do we auto draft products for brands where brandType===MANUAL?"
* "Where is this status handled?"
* "Does this worker retry failed jobs?"
* "What happens when this integration sync fails?"
* "Is this queue idempotent?"
* "Does this change affect Shopify imports?"

Prefer:

\`\`\`bash
horus explain "<symbol-or-behavior-hint>"
horus investigate "<behavior question>"
\`\`\`

Then ask follow-ups against the saved investigation:

\`\`\`bash
horus ask <id> "what source evidence proves this behavior?"
horus ask <id> "what source evidence disproves this behavior?"
horus ask <id> "what evidence is missing?"
\`\`\`

Correct \`horus ask\` usage:

\`\`\`bash
horus ask <id> "do we auto draft products for brands where brandType===MANUAL?"
\`\`\`

Incorrect usage:

\`\`\`bash
horus ask "do we auto draft products for brands where brandType===MANUAL?"
\`\`\`

\`horus ask\` requires an investigation ID and a directive.

## Saved investigations

Use saved investigations to continue from existing evidence instead of restarting randomly:

\`\`\`bash
horus investigations
horus replay <id>
horus ask <id> "what evidence is missing?"
horus ask <id> "what evidence contradicts <hypothesis>?"
horus postmortem <id>
horus score <id>
\`\`\`

## New codebase orientation

When entering an unfamiliar area of the repo:

\`\`\`bash
horus doctor
horus onboard [area]
horus explain <symbol-or-hint>
horus owner <symbol-or-hint>
\`\`\`

If \`horus doctor\` shows the repo is not set up, run \`horus init\` first.

## Change and fix workflow

For write or fix tasks:

1. Use Horus before editing to understand evidence, ownership, and blast radius.
2. Make code changes using normal filesystem tools.
3. Use Horus after editing to validate blast radius and relevant runtime/source assumptions.
4. Run normal project tests, typechecks, linters, or smoke checks as appropriate.

Example:

\`\`\`bash
horus investigate "<bug or behavior>"
horus blast-radius <symbol>
# edit files normally
horus blast-radius <changed-symbol>
horus ask <id> "does the proposed fix address the collected evidence?"
\`\`\`

## Reporting format

When answering after using Horus, report:

* Conclusion
* Horus evidence
* Source locations
* Missing, weak, stale, or ambient evidence
* Conflicts between Horus evidence and filesystem/source inspection
* Blast radius or risk
* Recommended next action

## Rules

* Treat Horus evidence as grounded but not infallible.
* Mention when Horus evidence is missing, stale, ambient, incomplete, or not structurally linked.
* Do not invent runtime evidence Horus did not collect.
* Prefer exact source locations from Horus over guesses.
* If Horus output conflicts with filesystem or source inspection, report the discrepancy.
* For write or fix tasks, use Horus to validate blast radius and rerun relevant checks after changes.
* Horus is read-only evidence collection. Never use Horus to mutate production systems.
* Do not hallucinate evidence. If Horus returns nothing, say so explicitly.
* Do not use Horus as a substitute for tests, typechecks, or direct source inspection.
* Do not overuse Horus for trivial syntax edits, formatting-only changes, or obvious local refactors unless blast radius matters.
`;

function skillFrontmatter(target: SkillTarget): string {
  const description = 'Grounded production-incident investigation with Horus — a read-only evidence layer over logs, metrics, queues, application state, and source intelligence. Use when debugging incidents, outages, regressions, or flaky/slow behavior; when asked what changed, what broke, who owns code, or the blast radius of a change; and to verify fixes against runtime evidence.';
  switch (target) {
    case 'claude':
      return `---\nname: horus\ndescription: ${description}\n---\n\n`;
    case 'cursor':
      return `---\ndescription: ${description}\nglobs: *\nalwaysApply: true\n---\n\n`;
    default:
      return '';
  }
}

const PROVIDER_NOTES: Record<SkillTarget, string> = {
  claude: `\
## Claude Code notes

This skill is loaded automatically when present at:

\`\`\`bash
.claude/skills/horus/SKILL.md
\`\`\`

Useful starting points:

\`\`\`bash
horus investigations
horus doctor
horus onboard [area]
horus status
\`\`\`
`,
  gemini: `\
## Gemini CLI notes

This context file is loaded automatically by Gemini CLI when present at:

\`\`\`bash
GEMINI.md
\`\`\`

Useful starting points:

\`\`\`bash
horus investigations
horus doctor
horus onboard [area]
horus status
\`\`\`
`,
  cursor: `\
## Cursor notes

This rule is loaded automatically when present at \`.cursor/rules/horus.mdc\`.

Useful starting points:

\`\`\`bash
horus investigations
horus doctor
horus onboard [area]
horus status
\`\`\`
`,
  codex: `\
## Codex notes

This file is loaded automatically by Codex CLI as project instructions when present at \`AGENTS.md\`.

Useful starting points:

\`\`\`bash
horus investigations
horus doctor
horus onboard [area]
horus status
\`\`\`
`,
  generic: '',
};

export function generateSkillContent(target: SkillTarget): string {
  return skillFrontmatter(target) + BASE_SKILL + '\n' + PROVIDER_NOTES[target];
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function runSkillInstall(
  target: string,
  opts: {
    force?: boolean;
    global?: boolean;
    cwd?: string;
    write?: (line: string) => void;
    confirm?: (message: string) => Promise<boolean>;
  },
): Promise<number> {
  const log = opts.write ?? ((line: string) => console.log(line));

  if (!isValidTarget(target)) {
    log(`${pc.red('✗')} Unknown target: ${pc.bold(target)}`);
    log(pc.dim(`  Supported targets: ${SUPPORTED_TARGETS.join(', ')}`));
    return 1;
  }

  const outPath = getSkillInstallPath(target, { global: opts.global, cwd: opts.cwd });
  const content = generateSkillContent(target);

  // Migrate legacy flat Claude skill file to the new directory layout.
  if (target === 'claude') {
    const legacyPath = getLegacyClaudeSkillPath({ global: opts.global, cwd: opts.cwd });
    if (existsSync(legacyPath)) {
      if (!opts.force) {
        const confirmed = await (opts.confirm ?? confirm)(
          `Found old flat skill file at ${legacyPath}. Replace it with the new directory layout?`,
        );
        if (!confirmed) {
          log(`${pc.yellow('!')} Migration cancelled; existing skill left untouched.`);
          log(pc.dim('  Pass --force to replace without prompting.'));
          return 1;
        }
      }
      try {
        rmSync(legacyPath);
        log(`${pc.yellow('!')} Replaced old flat skill file: ${legacyPath}`);
      } catch (err) {
        log(`${pc.red('✗')} Could not remove legacy skill file ${legacyPath}: ${(err as Error).message}`);
        return 1;
      }
    }
  }

  if (existsSync(outPath) && !opts.force) {
    log(`${pc.red('✗')} ${outPath} already exists`);
    log(pc.dim('  pass --force to overwrite'));
    return 1;
  }

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content, 'utf8');
  } catch (err) {
    log(`${pc.red('✗')} Could not write ${outPath}: ${(err as Error).message}`);
    return 1;
  }

  log(`${pc.green('✓')} Horus skill installed → ${outPath}`);

  if (target === 'claude') {
    log(pc.dim('  Claude Code will load this skill automatically.'));
    log(pc.dim('  Invoke it with: /horus'));
  } else if (target === 'gemini') {
    log(pc.dim('  Gemini CLI will load this context file automatically.'));
  } else if (target === 'cursor') {
    log(pc.dim('  Cursor will load this rule automatically.'));
  } else if (target === 'codex') {
    log(pc.dim('  Codex CLI will load this file automatically.'));
  } else {
    log(pc.dim(`  Copy or reference this file in your ${target} agent instructions.`));
  }

  return 0;
}

export async function runSkillPrint(
  target: string,
  opts: { write?: (line: string) => void },
): Promise<number> {
  const log = opts.write ?? ((line: string) => console.log(line));

  if (!isValidTarget(target)) {
    log(`${pc.red('✗')} Unknown target: ${pc.bold(target)}`);
    log(pc.dim(`  Supported targets: ${SUPPORTED_TARGETS.join(', ')}`));
    return 1;
  }

  process.stdout.write(generateSkillContent(target));
  return 0;
}

export async function runSkillPath(
  target: string,
  opts: {
    global?: boolean;
    cwd?: string;
    write?: (line: string) => void;
  },
): Promise<number> {
  const log = opts.write ?? ((line: string) => console.log(line));

  if (!isValidTarget(target)) {
    log(`${pc.red('✗')} Unknown target: ${pc.bold(target)}`);
    log(pc.dim(`  Supported targets: ${SUPPORTED_TARGETS.join(', ')}`));
    return 1;
  }

  const outPath = getSkillInstallPath(target, { global: opts.global, cwd: opts.cwd });
  log(outPath);
  return 0;
}

/** Verify the installed skill contains no secrets from .horus/config.json. */
export function skillContentLeaksSecrets(content: string): boolean {
  const secretPatterns = [
    /"password"\s*:/i,
    /"apiKey"\s*:/i,
    /"api_key"\s*:/i,
    /bearer\s+[a-z0-9._-]{20,}/i,
    /mongodb\+srv:\/\/[^@]+@/i,
    /redis:\/\/:[^@]+@/i,
    /postgresql:\/\/[^:]+:[^@]+@/i,
  ];
  return secretPatterns.some((p) => p.test(content));
}
