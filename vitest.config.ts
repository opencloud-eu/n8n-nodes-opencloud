/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/unit/**/*.test.ts'],
		environment: 'node',
		globals: false,
	},
});
