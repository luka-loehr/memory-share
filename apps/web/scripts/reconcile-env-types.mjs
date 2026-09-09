/**
 * Post-process the output of `wrangler types`.
 *
 * `@opennextjs/cloudflare` declares `ASSETS?: Fetcher` and `IMAGES?: ImagesBinding`
 * on the global `CloudflareEnv` (they are genuinely optional — a deployment can
 * run without either). `wrangler types` emits both as REQUIRED from the
 * bindings in wrangler.jsonc. Two declarations of the same interface that
 * disagree on optionality make the merged interface fail its own `extends`
 * clause, which surfaces as TS2430 the moment any file adds a
 * `declare global { interface CloudflareEnv { … } }` augmentation.
 *
 * Optional is the honest shape — the app already guards both — so this relaxes
 * the generated file to match. Run automatically by the `cf-typegen` script so
 * regenerating types cannot silently reintroduce the clash.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../cloudflare-env.d.ts', import.meta.url);
const OPTIONAL = ['ASSETS', 'IMAGES'];

let source = readFileSync(FILE, 'utf8');
let changed = 0;

for (const binding of OPTIONAL) {
  const required = new RegExp(`^(\\s*)${binding}:\\s`, 'm');
  if (required.test(source)) {
    source = source.replace(required, `$1${binding}?: `);
    changed++;
  }
}

if (changed > 0) {
  writeFileSync(FILE, source);
  console.log(`reconcile-env-types: relaxed ${changed} binding(s) to optional`);
} else {
  console.log('reconcile-env-types: nothing to do');
}
