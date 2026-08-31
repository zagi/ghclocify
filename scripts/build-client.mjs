import { build } from 'esbuild';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Workers Assets serves public/ verbatim and asset routes shadow Worker routes.
// A file under public/api/ would silently shadow the API, so fail the build.
function assertNoApiDir(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'api') throw new Error(`public/api/ would shadow the Worker API: ${full}`);
      assertNoApiDir(full);
    }
  }
}

await build({
  entryPoints: ['client/app.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'public/app.js',
  // No sourcemap: public/ is served unauthenticated, and a map would publish
  // the full client source.
  sourcemap: false,
  minify: true,
});

assertNoApiDir('public');
console.log('client bundled -> public/app.js');
