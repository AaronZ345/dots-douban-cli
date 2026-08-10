import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  ensureAuth: vi.fn(),
  updateSubjectInterest: vi.fn(),
  unmarkSubject: vi.fn()
}));

vi.mock('../auth.js', () => ({
  ensureAuth: mocks.ensureAuth
}));
vi.mock('../api/mutations.js', () => ({
  SUBJECT_ACTIONS: { movie: 'movie' },
  updateSubjectInterest: mocks.updateSubjectInterest,
  unmarkSubject: mocks.unmarkSubject
}));
vi.mock('../utils/spinner.js', () => ({
  withSpinner: vi.fn(async (_message: string, task: () => Promise<unknown>) => task())
}));

import { registerMarkCommands } from '../commands/mark.ts';

const originalArgv = process.argv;

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerMarkCommands(program);
  return program;
}

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('mark commands', () => {
  it.each([
    ['mark', '1292052', '--wish', '--file', 'items.txt'],
    ['rate', '1292052', '--score', '5', '--file', 'ratings.txt'],
    ['comment', '1292052', 'good', '--file', 'comments.txt'],
    ['unmark', '1292052', '--file', 'items.txt']
  ])('rejects mixed inline and batch input for %s', async (...args) => {
    process.argv = ['node', 'douban', ...args, '--json'];
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await createProgram().parseAsync(process.argv);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0])).error.message)
      .toContain('--file 不能与单条模式参数同时使用');
    expect(mocks.ensureAuth).not.toHaveBeenCalled();
  });
});
