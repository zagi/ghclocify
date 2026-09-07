// Minimal ambient declarations for the one Node built-in this test suite
// needs. Installing `@types/node` for this alone would pull its global
// `fetch`/`Request`/`Response` declarations into the same program as
// `@cloudflare/workers-types`, which declares the same globals differently
// for the Workers runtime — so we shim just the bits `contrast.test.ts` uses
// instead of widening the whole project's ambient types.
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: string): string;
}

interface ImportMeta {
  url: string;
}
