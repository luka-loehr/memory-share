import { UsageError } from '../core/errors.ts';

export type FlagType = 'boolean' | 'string' | 'number' | 'list';

export interface FlagSpec {
  type: FlagType;
  short?: string;
  describe: string;
  placeholder?: string;
}

export type FlagSpecs = Record<string, FlagSpec>;

export type FlagValue = boolean | string | number | string[];

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, FlagValue>;
}

/**
 * A small, strict parser. Unknown flags are an error rather than a silent
 * no-op: `ms memory rm beach-week --force` should say that the flag is `--yes`,
 * not delete the memory while ignoring what the user asked for.
 */
export function parseArgs(argv: readonly string[], specs: FlagSpecs): ParsedArgs {
  const flags = new Map<string, FlagValue>();
  const positionals: string[] = [];
  const byShort = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.short !== undefined) byShort.set(spec.short, name);
  }

  const setFlag = (name: string, spec: FlagSpec, raw: string | undefined): void => {
    if (spec.type === 'boolean') {
      flags.set(name, true);
      return;
    }
    if (raw === undefined) throw new UsageError(`--${name} needs a value.`);
    if (spec.type === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value))
        throw new UsageError(`--${name} expects a number, got "${raw}".`);
      flags.set(name, value);
      return;
    }
    if (spec.type === 'list') {
      const previous = flags.get(name);
      const list = Array.isArray(previous) ? previous : [];
      flags.set(name, [...list, raw]);
      return;
    }
    flags.set(name, raw);
  };

  let passthrough = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) continue;
    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      const name = eq === -1 ? body : body.slice(0, eq);
      const inline = eq === -1 ? undefined : body.slice(eq + 1);

      if (name.startsWith('no-')) {
        const positive = name.slice(3);
        const spec = specs[positive];
        if (spec?.type === 'boolean') {
          flags.set(positive, false);
          continue;
        }
      }

      const spec = specs[name];
      if (spec === undefined) throw new UsageError(`Unknown flag --${name}.`, knownFlags(specs));
      if (spec.type === 'boolean') {
        if (inline !== undefined) {
          flags.set(name, inline !== 'false' && inline !== '0');
        } else {
          flags.set(name, true);
        }
        continue;
      }
      if (inline !== undefined) {
        setFlag(name, spec, inline);
        continue;
      }
      setFlag(name, spec, argv[++index]);
      continue;
    }

    if (token.length > 1 && token.startsWith('-')) {
      const letters = [...token.slice(1)];
      for (let position = 0; position < letters.length; position++) {
        const letter = letters[position];
        if (letter === undefined) continue;
        const name = byShort.get(letter);
        const spec = name === undefined ? undefined : specs[name];
        if (name === undefined || spec === undefined) {
          throw new UsageError(`Unknown flag -${letter}.`, knownFlags(specs));
        }
        if (spec.type === 'boolean') {
          flags.set(name, true);
          continue;
        }
        const rest = letters.slice(position + 1).join('');
        setFlag(name, spec, rest === '' ? argv[++index] : rest);
        break;
      }
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags };
}

function knownFlags(specs: FlagSpecs): string {
  const names = Object.keys(specs)
    .sort()
    .map((name) => `--${name}`);
  return names.length === 0 ? 'This command takes no flags.' : `Known flags: ${names.join(', ')}.`;
}

// ------------------------------------------------------------- accessors ----

export function getBool(args: ParsedArgs, name: string, fallback = false): boolean {
  const value = args.flags.get(name);
  return typeof value === 'boolean' ? value : fallback;
}

export function getString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function getNumber(args: ParsedArgs, name: string, fallback: number): number {
  const value = args.flags.get(name);
  return typeof value === 'number' ? value : fallback;
}

export function getList(args: ParsedArgs, name: string): string[] {
  const value = args.flags.get(name);
  return Array.isArray(value) ? value : [];
}

export function has(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}
