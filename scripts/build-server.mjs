// Compiles the backend's 3 TypeScript source files to plain JS under
// dist-server/, mirroring their source paths. This exists because some Node
// hosts (Hostinger's app manager included) require a literal .js entry file
// and run `node <entry>.js` directly — they don't run `npm start`/tsx, and a
// tsx runtime-loader shim under a .js filename hits an undocumented tsx
// quirk (silent no-op) rather than actually transforming the file. Precompiling
// removes the runtime loader entirely: the deployed entry is real JS, so any
// plain `node` host can run it with zero special configuration.
//
// This is transform-only (type-stripping), not a bundle: each file is
// compiled independently and npm package imports are left untouched, so they
// still resolve normally through node_modules at runtime. Only these 3 files
// are TypeScript in the backend — everything else the server imports is an
// npm package.
import { transformSync } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const files = [
  'server.ts',
  'shared/schema.ts',
  'src/utils/domainVariants.ts',
];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const { code } = transformSync(source, {
    loader: 'ts',
    format: 'esm',
    target: 'node22',
  });
  const outPath = join('dist-server', file.replace(/\.ts$/, '.js'));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, code);
  console.log(`built ${file} -> ${outPath}`);
}
