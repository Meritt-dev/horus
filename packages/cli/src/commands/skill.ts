import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';

export const SUPPORTED_TARGETS = [
  'claude',
  'codex',
  'gemini',
  'cursor',
  'generic',
] as const;
export type SkillTarget = (typeof SUPPORTED_TARGETS)[number];

export function isValidTarget(target: string): target is SkillTarget {
  return (SUPPORTED_TARGETS as readonly string[]).includes(target);
}

/** Legacy flat-file path used by early Horus Claude skill installers. */
export function getLegacyClaudeSkillPath(opts: {
  global?: boolean;
  cwd?: string;
}): string {
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
# Horus — grounded investigation

Horus is a read-only evidence layer over a repo's production runtime (logs, metrics,
queues, application state), source intelligence (symbols, call graph, ownership, blast
radius), and git history. Use it before answering from assumption about runtime
behavior, what changed, who owns code, blast radius, or whether code paths are actually
connected. It never mutates anything.

Add \`--json\` to any command (\`--format json\` for \`investigate\` and \`replay\`) when you
need to parse the result — output is stable and **compact by default**; add \`--full\`
for the uncapped structure. Every JSON result carries a \`nextSteps\` array of
deterministic follow-up commands; run those rather than guessing.

## When to invoke

Invoke Horus when the task involves: an incident / outage / regression / slow / flaky /
inconsistent behavior; "what changed" or "what caused this"; ownership of a component,
service, queue, worker, route, or module; blast radius or impact of a change; queues,
workers, Redis/BullMQ, logs, metrics, MongoDB/Postgres state; where business logic
lives; whether a flag / enum / status / branch is handled; whether code paths are truly
connected or only coincidentally similar; or verifying a fix. Skip it for trivial
syntax/formatting edits and obvious local refactors where blast radius doesn't matter.

## Setup (once per repo)

If there is no \`.horus/config.json\` (or \`horus doctor\` reports source intelligence
missing), run the single onboarding command — idempotent, safe to re-run:

\`\`\`bash
horus init
\`\`\`

It checks prerequisites, writes the config, starts the source-intelligence host,
indexes the code, and stitches the queue map. Add runtime sources with
\`horus connect <type>\` (elasticsearch / mongodb / postgres / sentry / axiom / shopify /
grafana / redis; credentials encrypted at rest — never hand-edit them into config). The
source backend ships inside the Horus bundle and installs automatically.

## Primary entry points

\`\`\`bash
horus status --json                            # config + connector health matrix
horus investigate --format json "<hint>"       # deterministic, ranked, evidence-backed report
horus packet "<hint>" --for claude --json      # compact, honesty-framed briefing for your context
\`\`\`

\`investigate\` returns a saved id. Reuse it — never restart from scratch:

\`\`\`bash
horus investigations --json                    # list saved ids
horus replay <id> --format json                # re-render a saved report, no re-query
horus ask <id> "what evidence is missing?"     # refine against already-collected evidence
horus postmortem <id>                          # draft an editable postmortem
horus score <id> --json                        # quality score for the investigation
\`\`\`

\`horus ask\` requires an investigation ID and a directive:

\`\`\`bash
horus ask <id> "what evidence contradicts <hypothesis>?"   # correct
horus ask "<question>"                                      # WRONG — missing id
\`\`\`

## Runtime evidence

\`\`\`bash
horus logs [service] --json
horus state --json
horus metrics "<hint>" --json
horus queues --live --json
\`\`\`

## Client-reported issues (Lens work queue)

Lens reports are bug reports clients filed from the running app. They feed
\`investigate\` as evidence, but you can also work the backlog DIRECTLY — every reported
issue, not just the ones relevant to one incident:

\`\`\`bash
horus lens --json                 # list every client report, newest first
horus lens --status open -n 100   # filter + widen the window
horus lens show <reportId> --json # full detail incl. the code seed (file:line to fix)
\`\`\`

\`show\` resolves the top stack frame of the report's first error into a \`seed\`
(\`file:line:symbol\` — the raise site), alongside the comment, route, release/gitSha, and
failing requests. Native/cloud-backed: needs \`horus login\` + \`horus cloud link\`;
degrades cleanly (a remedy, valid JSON) otherwise. Same reports are exposed to MCP as
\`list_lens_reports\` / \`get_lens_report\`.

## Source reasoning

\`\`\`bash
horus explain <symbol> --json          # location, callers/callees, impact, resolution kind
horus blast-radius <symbol> --json     # upstream/downstream reach + criticality
horus owner <symbol> --json            # likely owner from git history, with confidence
horus changes <base> [compare] --json  # changed symbols + affected execution flows
horus what-changed --json              # git truth: files by status, +/- lines, runtime/test/docs/config buckets
horus timeline --json
\`\`\`

Qualified names resolve precisely and identically across \`search\`, \`explain\`,
\`investigate\`, and \`blast-radius\` — prefer them to disambiguate a method from a
same-named helper or test: \`horus explain PaymentService.charge\`, \`horus blast-radius
Reply.hijack\`. Product code is preferred over tests/examples by default; add
\`--include-tests\` (or \`--full\`) when you need test callers too.

## Logic and behavior questions

For "do we auto-draft products when brandType===MANUAL?", "where is this status
handled?", "does this worker retry failed jobs?", "is this queue idempotent?" — resolve
from source, not assumptions:

\`\`\`bash
horus explain "<symbol-or-behavior>" --json
horus investigate --format json "<behavior question>"
horus ask <id> "what source evidence proves or disproves this behavior?"
\`\`\`

## Change and fix workflow

1. Before editing: \`horus investigate\` / \`horus blast-radius <symbol>\` to ground in
   evidence, ownership, and blast radius.
2. Edit with normal filesystem tools.
3. After editing: re-check \`horus blast-radius <changed-symbol>\`, then
   \`horus ask <id> "does the proposed fix address the collected evidence?"\`.
4. Run the project's own tests / typecheck / lint — Horus does not replace them.

## Close the loop

After you ACT on an investigation and know the outcome, record whether Horus pointed at
the real cause (non-interactive, safe unattended; report once, after you confirm — never
guess):

\`\`\`bash
horus feedback <id> --resolved yes      # pointed at the real cause
horus feedback <id> --resolved partly   # useful lead, not the whole cause
horus feedback <id> --resolved no       # missed the cause
# optionally add --manual-estimate-min <minutes>
\`\`\`

If Horus itself is wrong, crashes, or lacks a capability you needed, file it — you see
its failure modes firsthand, the highest-leverage way to improve it:

\`\`\`bash
horus report "<what was wrong or missing>"
\`\`\`

## Contract

- Horus evidence is grounded but **not infallible**. State when it is missing, stale,
  ambient, or not structurally linked to the symptom.
- **Do not invent runtime evidence** Horus did not collect. If **Horus returns nothing**,
  say so explicitly — never **hallucinate** a result.
- Prefer Horus's exact source locations over guesses. If Horus conflicts with direct
  source inspection, report the discrepancy.
- Horus is **read-only** evidence collection. **Never use Horus to mutate production**
  systems, and do not use it as a substitute for tests, typechecks, or source inspection.
- Report back: conclusion; Horus evidence + exact source locations; gaps / weak / stale
  evidence; **blast radius** or risk; recommended next action.
`;

function skillFrontmatter(target: SkillTarget): string {
  const description =
    'Grounded production-incident investigation with Horus — a read-only evidence layer over logs, metrics, queues, application state, and source intelligence. Use when debugging incidents, outages, regressions, or flaky/slow behavior; when asked what changed, what broke, who owns code, or the blast radius of a change; and to verify fixes against runtime evidence.';
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
        log(
          `${pc.red('✗')} Could not remove legacy skill file ${legacyPath}: ${(err as Error).message}`,
        );
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
