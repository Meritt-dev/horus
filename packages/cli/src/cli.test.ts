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

  it('setup and index are hidden deprecation stubs (registered, absent from help)', () => {
    const program = buildProgram();
    for (const name of ['setup', 'index']) {
      const cmd = program.commands.find((c) => c.name() === name);
      expect(cmd, `stub "${name}" should stay registered`).toBeDefined();
      // Commander hides via the `hidden` flag set by .command(name, { hidden: true }).
      expect((cmd as unknown as { _hidden: boolean })._hidden, `"${name}" should be hidden`).toBe(true);
    }
    // And the top-level help must not advertise them.
    let out = '';
    program.configureOutput({ writeOut: (s) => { out += s; }, writeErr: (s) => { out += s; } });
    program.outputHelp();
    // Commander lists visible commands at exactly two-space indent.
    expect(out).not.toMatch(/\n {2}setup\b/);
    expect(out).not.toMatch(/\n {2}index\b/);
    expect(out).toMatch(/\n {2}init\b/);
  });

  it('investigate command has --project, --env, --format options', () => {
    const investigate = buildProgram().commands.find((c) => c.name() === 'investigate')!;
    const longs = investigate.options.map((o) => o.long);
    expect(longs).toContain('--project');
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

  it('invoking a stub prints the merge pointer and exits 1', async () => {
    for (const name of ['setup', 'index']) {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.exitCode = 0;
      await buildProgram().parseAsync(['node', 'horus', name]);
      expect(errSpy.mock.calls.flat().join(' ')).toContain('merged into `horus init`');
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      errSpy.mockRestore();
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
    for (const opt of ['--name', '--env', '--source', '--path', '--config', '--project',
                       '--full', '--changed', '--fast', '--import-kb']) {
      expect(longs, `init should carry ${opt}`).toContain(opt);
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
    expect(help).toContain('--name');
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
    expect(help).toContain('--project');
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
