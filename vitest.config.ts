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
          ],
          environment: 'node',
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
