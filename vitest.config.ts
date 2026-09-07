import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'pure',
          include: [
            'test/timezone.test.ts',
            'test/describe.test.ts',
            'test/aggregate.test.ts',
            'test/plan.test.ts',
            'test/validate.test.ts',
            'test/hours.test.ts',
            'test/contrast.test.ts',
          ],
          environment: 'node',
          // Vitest mocks .css imports as empty by default (it assumes
          // they're stylesheets a component pulls in, not data to read) —
          // contrast.test.ts's `?raw` import of public/style.css needs the
          // real content, so CSS processing has to be turned on here.
          css: true,
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
        test: {
          name: 'worker',
          include: [
            'test/http.test.ts',
            'test/github.test.ts',
            'test/clockify.test.ts',
            'test/routes-*.test.ts',
            'test/index.test.ts',
          ],
        },
      },
    ],
  },
});
