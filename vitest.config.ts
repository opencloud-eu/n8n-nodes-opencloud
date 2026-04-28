/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['nodes/**/__tests__/**/*.test.ts', 'credentials/**/__tests__/**/*.test.ts'],
		environment: 'node',
		globals: false,
	},
});
