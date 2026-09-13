import { describe, expect, test } from 'bun:test';
import {
  type FlagSpecs,
  getBool,
  getList,
  getNumber,
  getString,
  parseArgs,
} from '../src/cli/args.ts';
import { UsageError } from '../src/core/errors.ts';

const SPECS: FlagSpecs = {
  tag: { type: 'list', short: 't', describe: 'tag' },
  concurrency: { type: 'number', short: 'c', describe: 'concurrency' },
  password: { type: 'string', describe: 'password' },
  download: { type: 'boolean', describe: 'download' },
  yes: { type: 'boolean', short: 'y', describe: 'yes' },
  json: { type: 'boolean', describe: 'json' },
};

describe('parseArgs', () => {
  test('collects positionals and repeated list flags', () => {
    const args = parseArgs(['a.jpg', 'b.jpg', '--tag', 'beach', '--tag', 'with-family'], SPECS);
    expect(args.positionals).toEqual(['a.jpg', 'b.jpg']);
    expect(getList(args, 'tag')).toEqual(['beach', 'with-family']);
  });

  test('accepts --flag=value as well as --flag value', () => {
    expect(getString(parseArgs(['--password=hunter2'], SPECS), 'password')).toBe('hunter2');
    expect(getString(parseArgs(['--password', 'hunter2'], SPECS), 'password')).toBe('hunter2');
  });

  test('--no-x turns a boolean off', () => {
    expect(getBool(parseArgs(['--no-download'], SPECS), 'download', true)).toBe(false);
    expect(getBool(parseArgs(['--download'], SPECS), 'download')).toBe(true);
    expect(getBool(parseArgs([], SPECS), 'download', true)).toBe(true);
  });

  test('short flags work, with an attached or a separate value', () => {
    expect(getNumber(parseArgs(['-c', '8'], SPECS), 'concurrency', 4)).toBe(8);
    expect(getNumber(parseArgs(['-c8'], SPECS), 'concurrency', 4)).toBe(8);
    expect(getBool(parseArgs(['-y'], SPECS), 'yes')).toBe(true);
  });

  test('bundled short booleans all register', () => {
    const args = parseArgs(['-y'], SPECS);
    expect(getBool(args, 'yes')).toBe(true);
  });

  test('everything after -- is a positional, even if it looks like a flag', () => {
    const args = parseArgs(['--', '--tag', '-y'], SPECS);
    expect(args.positionals).toEqual(['--tag', '-y']);
    expect(getBool(args, 'yes')).toBe(false);
  });

  test('an unknown flag is refused rather than ignored', () => {
    expect(() => parseArgs(['--force'], SPECS)).toThrow(UsageError);
    expect(() => parseArgs(['-z'], SPECS)).toThrow(UsageError);
  });

  test('a value flag with no value is an error', () => {
    expect(() => parseArgs(['--password'], SPECS)).toThrow(UsageError);
  });

  test('a non-numeric --concurrency is an error, not NaN', () => {
    expect(() => parseArgs(['--concurrency', 'lots'], SPECS)).toThrow(UsageError);
  });

  test('a file named like a flag survives after --', () => {
    const args = parseArgs(['upload', '--', '--weird-name.jpg'], SPECS);
    expect(args.positionals).toEqual(['upload', '--weird-name.jpg']);
  });

  test('accessors fall back when the flag is absent', () => {
    const args = parseArgs([], SPECS);
    expect(getString(args, 'password')).toBeUndefined();
    expect(getList(args, 'tag')).toEqual([]);
    expect(getNumber(args, 'concurrency', 4)).toBe(4);
  });
});
