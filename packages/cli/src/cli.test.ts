import { describe, it, expect, vi } from 'vitest';
import { buildProgram } from './index.js';
import { HORUS_VERSION } from '@horus/core';

describe('CLI program structure', () => {
  it('has the correct name', () => {
    expect(buildProgram().name()).toBe('horus');
  });

  it('description mentions investigation', () => {
    expect(buildProgram().description()).toContain('investigation');
  });

  it('embeds HORUS_VERSION in the version string', () => {
    // Commander's .version() getter returns the string set via .version(str, flags, desc).
    // buildProgram() calls .version(`horus ${HORUS_VERSION}`) so the two must agree exactly.
    expect(buildProgram().version()).toBe(`horus ${HORUS_VERSION}`);
  });

  it('registers all release-critical commands', () => {
    const names = buildProgram().commands.map((c) => c.name());
    const required = [
      'init',
      'projects',
      'connect',
      'stop',
      'hosts',
      'status',
      'investigate',
      'queues',
      'explain',
      'changes',
      'timeline',
      'what-changed',
      'replay',
      'logs',
      'metrics',
    ];
    for (const cmd of required) {
      expect(names, `command "${cmd}" should be registered`).toContain(cmd);
    }
  });

  it('registers the full command set (no silent regressions)', () => {
    const names = buildProgram().commands.map((c) => c.name());
    // Smoke-check additional commands beyond the release-critical set.
    for (const cmd of ['architecture', 'blast-radius', 'repos', 'search', 'investigations',
                        'postmortem', 'owner', 'score', 'scores', 'ask', 'onboard',
                        'simulate', 'state']) {
      expect(names, `command "${cmd}" should be registered`).toContain(cmd);
    }
  });

  it('top-level help lists init and never setup/index', () => {
    const program = buildProgram();
    let out = '';
    program.configureOutput({ writeOut: (t) => { out += t; }, writeErr: (t) => { out += t; } });
    program.outputHelp();
    // Commander lists visible commands at exactly two-space indent.
    expect(out).not.toMatch(/\n {2}setup\b/);
    expect(out).not.toMatch(/\n {2}index\b/);
    expect(out).toMatch(/\n {2}init\b/);
  });

  it('investigate command has --env, --format options (and NO --project)', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const longs = investigate.options.map((o) => o.long);
    expect(longs).not.toContain('--project');
    expect(longs).toContain('--env');
    expect(longs).toContain('--format');
  });

  it('investigate command has --ai and --ai-model options', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const longs = investigate.options.map((o) => o.long);
    expect(longs).toContain('--ai');
    expect(longs).toContain('--ai-model');
  });

  it('investigate --ai option description mentions ANTHROPIC_API_KEY', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const aiOpt = investigate.options.find((o) => o.long === '--ai');
    expect(aiOpt?.description).toContain('ANTHROPIC_API_KEY');
  });

  it('investigate --ai is a boolean flag (no required argument)', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const aiOpt = investigate.options.find((o) => o.long === '--ai');
    // Boolean flags have required=false and optional=false
    expect(aiOpt?.required).toBe(false);
    expect(aiOpt?.optional).toBe(false);
  });

  it('setup and index are fully REMOVED — unknown commands, no stubs, no help pages', () => {
    // `horus init` is the only onboarding/indexing command. The old names must fail
    // exactly like any other unknown command (no compatibility shim).
    const program = buildProgram();
    expect(program.commands.some((c) => c.name() === 'setup')).toBe(false);
    expect(program.commands.some((c) => c.name() === 'index')).toBe(false);
    for (const name of ['setup', 'index']) {
      expect(() =>
        buildProgram().exitOverride().configureOutput({ writeErr: () => {} })
          .parse(['node', 'horus', name]),
      ).toThrow(/unknown command/i);
    }
  });

  it('connect command requires a <type> argument', () => {
    const connect = buildProgram().commands.find((c) => c.name() === 'connect')!;
    expect(connect.registeredArguments.length).toBeGreaterThan(0);
    expect(connect.registeredArguments[0]?.name()).toBe('type');
  });

  it('init carries the full merged option set (old init + index flags)', () => {
    const init = buildProgram().commands.find((c) => c.name() === 'init')!;
    const longs = init.options.map((o) => o.long);
    for (const opt of ['--env', '--source', '--path', '--config',
                       '--full', '--changed', '--fast', '--import-kb']) {
      expect(longs, `init should carry ${opt}`).toContain(opt);
    }
    // Registry targeting is REMOVED: the repo's config/cwd is the project identity.
    expect(longs).not.toContain('--name');
    expect(longs).not.toContain('--project');
  });

  it('no audited command carries --name/--project (config/cwd is the identity)', () => {
    // Cross-repo targeting is `--config <path>` (or cd into the repo) — nothing else.
    // connect keeps --project as the SENTRY PROJECT SLUG (domain data, not targeting);
    // cloud link keeps --project as the CLOUD project picker.
    const audited = ['investigate', 'packet', 'logs', 'metrics', 'queues', 'state',
                     'status', 'init', 'explain', 'architecture', 'blast-radius',
                     'repos', 'search', 'ask', 'replay', 'postmortem', 'score',
                     'feedback', 'watch'];
    const program = buildProgram();
    for (const name of audited) {
      const cmd = program.commands.find((c) => c.name() === name);
      if (cmd === undefined) continue;
      const longs = cmd.options.map((o) => o.long);
      expect(longs, `${name} must not carry --name`).not.toContain('--name');
      expect(longs, `${name} must not carry --project`).not.toContain('--project');
    }
  });

  it('NO command anywhere carries --project or --name — recursively, subcommands included', () => {
    // The config/cwd IS the project identity; even domain data uses distinct spellings
    // (`connect --sentry-project`, `cloud link <org/workspace/project>` positional).
    const walk = (cmds: readonly import('commander').Command[], path: string): void => {
      for (const cmd of cmds) {
        const longs = cmd.options.map((o) => o.long);
        expect(longs, `${path}${cmd.name()} must not carry --project`).not.toContain('--project');
        expect(longs, `${path}${cmd.name()} must not carry --name`).not.toContain('--name');
        walk(cmd.commands, `${path}${cmd.name()} `);
      }
    };
    walk(buildProgram().commands, '');
  });

  it('every --repo option documents repo-WITHIN-config semantics (not cross-repo targeting)', () => {
    // --repo is deliberately kept: it selects a repository/project WITHIN the loaded
    // config in monorepo/multi-project setups. Cross-repo targeting is --config or cd.
    // Every description must say so, so it can never read as registry-style targeting.
    const walk = (cmds: readonly import('commander').Command[]): void => {
      for (const cmd of cmds) {
        const repoOpt = cmd.options.find((o) => o.long === '--repo');
        if (repoOpt) {
          expect(
            repoOpt.description,
            `${cmd.name()} --repo description must state WITHIN-config semantics`,
          ).toContain('WITHIN the loaded config');
        }
        walk(cmd.commands);
      }
    };
    walk(buildProgram().commands);
  });

  it('the domain replacements exist: connect --sentry-project and cloud link [target]', () => {
    const program = buildProgram();
    const connect = program.commands.find((c) => c.name() === 'connect')!;
    expect(connect.options.map((o) => o.long)).toContain('--sentry-project');
    const cloud = program.commands.find((c) => c.name() === 'cloud')!;
    const link = cloud.commands.find((c) => c.name() === 'link')!;
    // Non-interactive linking is the positional target, not a flag.
    expect(link.registeredArguments.map((a) => a.name())).toContain('target');
  });

  it('agent-facing list commands carry --json (status, investigations, scores)', () => {
    const program = buildProgram();
    for (const name of ['status', 'investigations', 'scores']) {
      const cmd = program.commands.find((c) => c.name() === name)!;
      expect(cmd.options.map((o) => o.long), `${name} should carry --json`).toContain('--json');
    }
  });

  it('heavy-JSON commands carry --full to opt out of the compact default', () => {
    const program = buildProgram();
    for (const name of ['changes', 'timeline', 'what-changed']) {
      const cmd = program.commands.find((c) => c.name() === name)!;
      const longs = cmd.options.map((o) => o.long);
      expect(longs, `${name} should carry --json`).toContain('--json');
      expect(longs, `${name} should carry --full`).toContain('--full');
    }
  });

  it('stop command has --all flag', () => {
    const stop = buildProgram().commands.find((c) => c.name() === 'stop')!;
    const longs = stop.options.map((o) => o.long);
    expect(longs).toContain('--all');
  });

  it('investigate command has --since option (HOR-86)', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const longs = investigate.options.map((o) => o.long);
    expect(longs).toContain('--since');
  });

  it('investigate --since accepts a value argument (not a boolean flag)', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const sinceOpt = investigate.options.find((o) => o.long === '--since');
    // A value option has required=true (mandatory arg) or optional=true (optional arg)
    expect(sinceOpt?.required || sinceOpt?.optional).toBe(true);
  });

  it('doctor command has --config option (HOR-85)', () => {
    const doctor = buildProgram().commands.find((c) => c.name() === 'doctor')!;
    const longs = doctor.options.map((o) => o.long);
    expect(longs).toContain('--config');
  });
});

describe('CLI help text examples (HOR-133)', () => {
  function captureHelp(name: string): string {
    const cmd = buildProgram().commands.find((c) => c.name() === name)!;
    let out = '';
    cmd.configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } });
    cmd.outputHelp();
    return out;
  }

  it('init help includes usage examples', () => {
    const help = captureHelp('init');
    expect(help).toContain('Examples:');
    expect(help).toContain('horus init');
    expect(help).not.toContain('--name');
  });

  it('doctor help includes usage examples', () => {
    const help = captureHelp('doctor');
    expect(help).toContain('Examples:');
    expect(help).toContain('horus doctor');
    expect(help).toContain('--json');
  });

  it('investigate help includes usage examples', () => {
    const help = captureHelp('investigate');
    expect(help).toContain('Examples:');
    expect(help).toContain('horus investigate');
    expect(help).not.toContain('--project');
  });

  it('investigations help includes usage examples', () => {
    const help = captureHelp('investigations');
    expect(help).toContain('Examples:');
    expect(help).toContain('horus investigations');
  });

  it('replay help includes usage examples and refers to investigations command', () => {
    const help = captureHelp('replay');
    expect(help).toContain('Examples:');
    expect(help).toContain('horus replay');
    expect(help).toContain('horus investigations');
  });

  it('postmortem help includes usage examples and refers to investigations command', () => {
    const help = captureHelp('postmortem');
    expect(help).toContain('Examples:');
    expect(help).toContain('horus postmortem');
    expect(help).toContain('horus investigations');
  });
});
