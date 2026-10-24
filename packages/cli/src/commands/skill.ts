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
# Horus: grounded investigation

Horus is a **read-only** evidence layer over a repo's production runtime (logs, metrics,
queues, application state), source intelligence (symbols, call graph, ownership, blast
radius) and git history. Use it instead of assuming; skip it for formatting edits and
obvious local refactors. It never writes to production systems, only to its own local
state (\`.horus/\`, saved investigations, feedback).

## Cheapest path to an answer

Stop at the first step that answers.

1. Reuse: \`horus investigations --json -n 5\`. If one matches, use its id with
   \`horus packet <id> --json\` or \`horus ask <id>\`. Neither re-queries.
2. Symbol, path, owner, impact or change questions: one Source reasoning command, not
   an investigation.
3. New incident: \`horus packet "<symptom, service, error text>" --for claude --json\`
   runs one investigation and returns a short briefing with caveats and recalled prior
   incidents. Read the memory section first.
4. Only if the packet is not enough: \`horus investigate --json "<hint>"\`, then
   \`horus ask <id>\`.

## Output

- Add \`--json\` to parse a result. \`replay\` takes \`--format json\`; \`postmortem\`,
  \`feedback\` and \`report\` have no JSON mode.
- JSON from \`investigate\`, \`explain\`, \`changes\`, \`timeline\` and \`what-changed\` is
  **compact by default**. Add \`--full\` only for raw payloads, commit lists or graph edges.
  \`horus replay <id> --format json\` is always full; use \`horus packet <id> --json\`.
- \`investigate\`, \`packet\`, \`explain\`, \`blast-radius\` and \`memory show\` return
  \`nextSteps\`. Prefer them to guessing; they are advisory and some name an MCP tool.
- Do not add \`--ai\`: it spends model tokens on a narrative you can write.

## Setup and health

Run \`horus init\` (**idempotent**) and retry once if \`.horus/config.json\` is missing,
\`horus doctor --json\` reports source intelligence missing, or the host is unreachable or
the index stale; \`horus init --reindex\` if the call graph still looks wrong.
\`horus status --json\` shows connector health. \`horus connect <type>\` adds a source
(\`--help\` lists types). Never invent credentials or hand-edit them into config; ask the
user.

## Investigation loop

\`investigate\` and \`packet "<hint>"\` save the run and return its id. Reuse it.

\`\`\`bash
horus investigate --json "<hint>" --service <name> --scope <path> --since <git-ref> --logs-since 24h
horus ask <id> "what evidence is missing?"
horus score <id> --json
horus postmortem <id>          # editable Markdown draft
\`\`\`

\`horus ask\` requires an investigation ID and a directive:

\`\`\`bash
horus ask <id> "what evidence contradicts <hypothesis>?"   # correct
horus ask "<question>"                                      # WRONG: no investigation ID
\`\`\`

\`ask\` is deterministic, not a chat model. It answers what is missing, what contradicts a
topic, why confidence is not higher, "focus on <topic>" and "where is X defined?".
Anything else gets "cannot be answered from the saved evidence".

Stop and report when the top cause has direct evidence and an exact source location,
when \`nextSteps\` is empty or repeats what you ran, or when the remaining gaps need a
connector or credential you lack. Do not run more than three refinement rounds without
new evidence.

## Empty or degraded results

- **Horus returns nothing**: retry once with a qualified name, \`horus search\`, a wider
  window (\`--logs-since 7d\`) or \`--service\`, then report the gap.
- Degraded or missing connector: use what was collected, name the gap, run the remedy
  in \`nextSteps\`.
- \`explain\` fuzzy match: the symbol was not found. Say so. Report low confidence as low.

## Runtime evidence

Use these only for a signal the packet lacked.

\`\`\`bash
horus logs [service] --since 24h --json   # Elasticsearch or cloud logs; --grep, --where k=v
horus metrics "<hint>" --since 6h --json  # Grafana
horus queues --live --json                # Redis/BullMQ, Kafka, Service Bus
horus state --json                        # MongoDB only
\`\`\`

## Source reasoning

\`\`\`bash
horus search "<words>" --json          # find symbols across configured repos
horus explain <symbol> --json          # location, callers/callees, impact
horus trace <from> <to> --json         # shortest code path between two symbols
horus blast-radius <symbol> --json     # upstream/downstream reach, criticality
horus owner <symbol> --json            # likely owner from git history
horus changes <base> [compare] --json  # changed symbols, flows, past incidents in that code
horus what-changed --json              # changed files by status and bucket
horus memory show <scope> --json       # past investigations, weak spots
\`\`\`

Qualified names resolve precisely across \`search\`, \`explain\`, \`investigate\` and
\`blast-radius\`: \`horus explain PaymentService.charge\`. Product code ranks above tests;
add \`--include-tests\` to \`blast-radius\` or \`--full\` to \`explain\`.

## Logic and behavior questions

For "does this worker retry failed jobs?", answer from source. \`explain\` takes a symbol,
not a sentence: \`horus search\`, \`horus explain\`, then \`horus trace\`. Horus locates code;
it does not prove behavior. Read the cited file:line before answering.

## Client-reported issues (Lens)

\`horus lens --json\` lists submitted client reports (\`--all\` for every status).
\`horus lens show <reportId> --json\` adds a \`seed\` (\`file:line:symbol\` raise site, or
null). Needs \`horus login\` and \`horus cloud link\`; otherwise it returns a remedy.

## Change and fix workflow

1. Before editing: \`horus blast-radius <symbol> --json\` and \`horus owner <symbol> --json\`.
2. Edit with normal file tools.
3. After editing: re-run \`horus blast-radius <changed-symbol> --json\`, and
   \`horus changes <base> --json\` once committed. \`horus ask\` cannot judge a fix; after
   it ships, run a fresh \`horus investigate\` on the original hint.
4. Run the project's own tests, typecheck and lint.

## Close the loop

Once the outcome is confirmed, record it once; never guess. The id defaults to the
latest investigation:

\`\`\`bash
horus feedback <id> --resolved yes|partly|no [--cause "<confirmed cause>"]
\`\`\`

If Horus was wrong or lacked a capability, \`horus report "<what>"\` prints a pre-filled
GitHub issue URL and sends nothing. Include the URL in your report.

## Running unattended

Do not wait for a human: run \`horus init\` if needed, follow the cheapest path and
\`nextSteps\`, apply the stop rules, report. Only credentials need a human.

## Contract

- Horus evidence is grounded but **not infallible**. Say when it is missing, stale,
  ambient, or not linked to the symptom.
- **Do not invent runtime evidence**. If **Horus returns nothing**, say so. Never
  **hallucinate** a result.
- Prefer Horus's exact source locations. If they conflict with the source, report it.
- **Never use Horus to mutate production**. It does not replace tests or reading source.
- Report: conclusion; investigation id; evidence with exact locations; gaps;
  **blast radius** or risk; next action.
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
