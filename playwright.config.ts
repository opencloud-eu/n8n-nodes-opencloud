/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals */
import { defineConfig, devices } from '@playwright/test';

const N8N_URL = process.env.N8N_URL ?? 'http://localhost:5678';

export default defineConfig({
	testDir: './tests/e2e',
	fullyParallel: false, // serial: each test mutates the same n8n + OpenCloud
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	use: {
		baseURL: N8N_URL,
		ignoreHTTPSErrors: true,
		// Capture artifacts on failure to make CI debugging tractable.
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
});
