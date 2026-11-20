import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:3080', viewport: { width: 1366, height: 900 } },
  webServer: { command: 'npm run demo', url: 'http://127.0.0.1:3080/api/v1/health', timeout: 30000 },
});
