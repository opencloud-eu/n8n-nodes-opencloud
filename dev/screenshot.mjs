// One-off recipe: log into the running docker-compose n8n, create a
// throwaway credential, import the example smoke workflow, and snap a wide
// canvas screenshot for the README.
//
// Prereqs: `docker compose up -d` (or `--profile ci up -d`).
//
// Run from repo root:
//   OPENCLOUD_URL=https://opencloud:9200 node dev/screenshot.mjs

import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const cfg = {
	openCloudUrl: process.env.OPENCLOUD_URL ?? 'https://opencloud:9200',
	openCloudUser: process.env.OPENCLOUD_USER ?? 'admin',
	openCloudPassword: process.env.OPENCLOUD_PASSWORD ?? 'admin',
	n8nUrl: process.env.N8N_URL ?? 'http://localhost:5678',
	n8nEmail: process.env.N8N_EMAIL ?? 'admin@example.com',
	n8nPassword: process.env.N8N_PASSWORD ?? 'admin',
	out: path.resolve(process.cwd(), 'docs/smoke-workflow.png'),
};

const browser = await chromium.launch({ headless: true });
// Wide viewport so the full smoke chain (14 nodes laid out horizontally)
// fits on screen — that's what makes the screenshot useful as a docs hero.
// 2x device scale for retina-quality output that still looks good when
// GitHub renders it at ~800-1000px column width.
const ctx = await browser.newContext({
	ignoreHTTPSErrors: true,
	viewport: { width: 2800, height: 900 },
	deviceScaleFactor: 2,
});
await ctx.setExtraHTTPHeaders({ 'browser-id': randomUUID() });
const page = await ctx.newPage();

await page.goto(`${cfg.n8nUrl}/signin`, { waitUntil: 'domcontentloaded' });
await page.getByRole('textbox', { name: /email/i }).fill(cfg.n8nEmail);
await page.getByRole('textbox', { name: /password/i }).fill(cfg.n8nPassword);
await Promise.all([
	page.waitForURL((u) => !/\/signin\b/.test(u.toString()), { timeout: 15_000 }),
	page.getByRole('button', { name: /sign in/i }).click(),
]);

const credResp = await page.request.post(`${cfg.n8nUrl}/rest/credentials`, {
	data: {
		name: `OpenCloud (screenshot ${Date.now()})`,
		type: 'openCloudApi',
		data: {
			serverUrl: cfg.openCloudUrl,
			user: cfg.openCloudUser,
			password: cfg.openCloudPassword,
			skipTlsVerification: true,
		},
	},
});
if (!credResp.ok()) throw new Error(`credentials POST ${credResp.status()}`);
const credId = (await credResp.json()).data.id;

const patcher = path.resolve(process.cwd(), 'examples', 'apply-credentials.sh');
const wf = JSON.parse(execFileSync(patcher, [credId]).toString());

const importResp = await page.request.post(`${cfg.n8nUrl}/rest/workflows`, {
	data: { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? {} },
});
if (!importResp.ok()) throw new Error(`workflows POST ${importResp.status()}`);
const wfId = (await importResp.json()).data.id;

await page.goto(`${cfg.n8nUrl}/workflow/${wfId}`, { waitUntil: 'networkidle' });
// Let the canvas finish laying out + render the node icons.
await page.waitForTimeout(2500);

// Fit-to-view so the whole chain is visible. The canvas viewport is wide
// (see deviceScaleFactor + viewport above) so the resulting image keeps
// the nodes readable even though all 14 are shown side-by-side.
const fit = page.locator('[data-test-id="zoom-to-fit"], button[title*="Fit" i]').first();
if (await fit.count()) await fit.click();
else await page.keyboard.press('Shift+1').catch(() => {});
await page.waitForTimeout(600);

// Crop to the canvas area — drops the side rail + header for a cleaner
// doc image. Falls back to full viewport if the locator isn't found.
const canvas = page.locator('[data-test-id="canvas"]').first();
await mkdir(path.dirname(cfg.out), { recursive: true });
if (await canvas.count()) {
	await canvas.screenshot({ path: cfg.out });
} else {
	await page.screenshot({ path: cfg.out, fullPage: false });
}
console.log(`wrote ${cfg.out}`);

await browser.close();
