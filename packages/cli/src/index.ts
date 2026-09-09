#!/usr/bin/env bun
import { type FlagSpecs, getBool, type ParsedArgs, parseArgs } from './cli/args.ts';
import { type CommandHelp, renderCommandHelp, renderGlobalHelp } from './cli/help.ts';
import { deploy, deployFlags } from './commands/deploy.ts';
import { download, downloadFlags } from './commands/download.ts';
import { login, loginFlags } from './commands/login.ts';
import { ls, lsFlags } from './commands/ls.ts';
import { memory, memoryFlags } from './commands/memory.ts';
import { status, statusFlags } from './commands/status.ts';
import { tag, tagFlags } from './commands/tag.ts';
import { uninstall, uninstallFlags } from './commands/uninstall.ts';
import { upload, uploadFlags } from './commands/upload.ts';
import { CliError, EXIT } from './core/errors.ts';
import * as out from './ui/out.ts';

const VERSION = '0.1.0';

const HELP: FlagSpecs = {
  help: { type: 'boolean', short: 'h', describe: 'Show help for this command' },
};

interface Command extends CommandHelp {
  run: (args: ParsedArgs) => Promise<number>;
}

const COMMANDS: Command[] = [
  {
    name: 'login',
    summary: 'Store the worker URL and admin token, at 0600',
    usage: ['ms login', 'ms login --url https://ms.example.workers.dev --token <token>'],
    flags: loginFlags,
    run: login,
    details: ['Values are never echoed or logged; the confirmation shows a fingerprint only.'],
  },
  {
    name: 'deploy',
    summary: 'Provision R2, D1 and the worker into your own Cloudflare account',
    usage: ['ms deploy', 'ms deploy --config ./wrangler.jsonc --verbose'],
    flags: deployFlags,
    run: deploy,
    details: [
      'Idempotent: existing resources are detected and reused rather than recreated.',
      'Secrets are generated with crypto.randomBytes and passed to wrangler over stdin.',
    ],
  },
  {
    name: 'upload',
    summary: 'Add files to the pool: hash, transcode video, upload, resumably',
    usage: [
      'ms upload ~/Pictures/croatia --tag croatia --tag 2019',
      'ms upload a.jpg b.mov -c 8 -j 4',
      'ms upload clips/ --dry-run',
    ],
    flags: uploadFlags,
    run: upload,
    details: [
      'Files are identified by sha256, so re-running after an interrupt skips what finished.',
      'Video is transcoded locally to a 1080p H.264 + faststart proxy with a bundled ffmpeg.',
      'Video already H.264 MP4 within 1080p is uploaded as-is and marked view_is_original.',
      'One video failing to encode never aborts the batch.',
    ],
  },
  {
    name: 'ls',
    summary: 'List the asset pool',
    usage: ['ms ls', 'ms ls --tag croatia --kind photo', 'ms ls --json'],
    flags: lsFlags,
    run: ls,
  },
  {
    name: 'tag',
    summary: 'Add or remove tags, on named assets or in bulk',
    usage: ['ms tag a1b2c3 d4e5f6 --add croatia', 'ms tag --from croatia --add 2019 --remove todo'],
    flags: tagFlags,
    run: tag,
  },
  {
    name: 'memory',
    summary: 'Create and manage shareable albums',
    usage: [
      'ms memory create "Croatia" --tag croatia --expires 30d',
      'ms memory ls',
      'ms memory show croatia-2019',
      'ms memory add croatia-2019 --tag with-mom',
      'ms memory set croatia-2019 --expires 90d',
      'ms memory rotate croatia-2019',
      'ms memory rm croatia-2019',
    ],
    flags: memoryFlags,
    run: memory,
    details: ['Deleting a memory never deletes assets — only the album and its link.'],
  },
  {
    name: 'download',
    summary: 'Pull originals back out, verified against their hash',
    usage: [
      'ms download croatia-2019 ./out',
      'ms download --tag croatia ./out',
      'ms download --tag croatia --variant view ./proxies',
    ],
    flags: downloadFlags,
    run: download,
    details: [
      'Reads through the owner API, never by unlocking a memory.',
      'Every original is re-hashed after writing; a mismatch is reported loudly and quarantined.',
      'Interrupted transfers resume from the bytes already on disk.',
    ],
  },
  {
    name: 'status',
    summary: 'Pool size, memory count, and the local media toolchain',
    usage: ['ms status', 'ms status --json'],
    flags: statusFlags,
    run: status,
  },
  {
    name: 'uninstall',
    summary: 'Delete local credentials and caches (Cloudflare is untouched)',
    usage: ['ms uninstall', 'ms uninstall --yes'],
    flags: uninstallFlags,
    run: uninstall,
    details: [
      'The bundled ffmpeg lives in node_modules and goes with the package itself.',
      'This removes ~/.config/memory-share, which a package manager would leave behind.',
    ],
  },
];

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;

  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    const topic = rest[0];
    const command = COMMANDS.find((entry) => entry.name === topic);
    process.stdout.write(
      command === undefined ? renderGlobalHelp(COMMANDS, VERSION) : renderCommandHelp(command),
    );
    return name === undefined ? EXIT.usage : EXIT.ok;
  }
  if (name === '--version' || name === '-V' || name === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }

  const command = COMMANDS.find((entry) => entry.name === name);
  if (command === undefined) {
    out.fail(`Unknown command "${name}".`);
    out.hint(`Try one of: ${COMMANDS.map((entry) => entry.name).join(', ')}.`);
    return EXIT.usage;
  }

  const args = parseArgs(rest, { ...command.flags, ...HELP });
  if (getBool(args, 'help')) {
    process.stdout.write(renderCommandHelp(command));
    return EXIT.ok;
  }
  if (getBool(args, 'json')) out.setJsonMode(true);

  return await command.run(args);
}

/**
 * `ms ls | head` closes stdout under us. That is a normal thing for a user to
 * do, not an error, so EPIPE ends the process quietly instead of printing a
 * stack trace about the pipe that the user cannot read anyway.
 */
function isBrokenPipe(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'EPIPE'
  );
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: unknown) => {
    if (!isBrokenPipe(error)) throw error;
    process.exit(0);
  });
}

/**
 * Ctrl-C during a progress render would otherwise leave the terminal with a
 * hidden cursor, which persists after the process is gone.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (process.stdout.isTTY === true) process.stdout.write('\x1b[?25h');
    if (process.stderr.isTTY === true) process.stderr.write('\x1b[?25h');
    process.exit(EXIT.cancelled);
  });
}

/** One place decides what the user sees when something goes wrong. */
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof CliError) {
      out.fail(error.message);
      if (error.hint !== undefined) out.hint(error.hint);
      process.exitCode = error.code;
      return;
    }
    if (isBrokenPipe(error)) {
      process.exit(0);
    }
    if (error instanceof Error && error.name === 'AbortError') {
      out.fail('Interrupted.');
      process.exitCode = EXIT.cancelled;
      return;
    }
    out.fail(error instanceof Error ? error.message : String(error));
    if (process.env.MS_DEBUG !== undefined && error instanceof Error) {
      process.stderr.write(`${error.stack ?? ''}\n`);
    } else {
      out.hint('Set MS_DEBUG=1 for a stack trace.');
    }
    process.exitCode = EXIT.api;
  });
