/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * Regression: when OpenCloud is unreachable, the OpenCloud node must surface
 * a clear, actionable error message. Previously n8n's stock string
 * ("The connection cannot be established, this usually occurs due to an
 * incorrect host (domain) value") leaked through unchanged, and downstream
 * Code nodes consuming a continueOnFail-substituted `{error}` item produced
 * cryptic "[null,null,…] No personal drive…" messages.
 *
 * This test points the credential at an unresolvable host, runs a one-node
 * Space:List workflow, and asserts the error message names the server URL.
 */

const cfg = {
	openCloudUrl: 'https://opencloud-not-resolvable.invalid:9200',
	n8nUrl: process.env.N8N_URL ?? 'http://localhost:5678',
	n8nEmail: process.env.N8N_EMAIL ?? 'admin@example.com',
	n8nPassword: process.env.N8N_PASSWORD ?? 'admin',
};

test('unreachable OpenCloud surfaces a clear error', async ({ page, context }) => {
	await context.setExtraHTTPHeaders({ 'browser-id': randomUUID() });
	await page.goto(`${cfg.n8nUrl}/signin`, { waitUntil: 'domcontentloaded' });
	await page.getByRole('textbox', { name: /email/i }).fill(cfg.n8nEmail);
	await page.getByRole('textbox', { name: /password/i }).fill(cfg.n8nPassword);
	await Promise.all([
		page.waitForURL((u) => !/\/signin\b/.test(u.toString()), { timeout: 15_000 }),
		page.getByRole('button', { name: /sign in/i }).click(),
	]);
	const api = page.request;

	const credId = await createCredential(api);
	const wfId = await importMinimalListWorkflow(api, credId);
	const execId = await runFromTrigger(api, wfId);
	const { status, errorMessage } = await pollExecution(api, execId, 30_000);

	expect(status, 'execution should have failed').toBe('error');
	expect(errorMessage).toContain('Cannot reach OpenCloud server at');
	expect(errorMessage).toContain(cfg.openCloudUrl);
});

async function createCredential(api: APIRequestContext): Promise<string> {
	const res = await api.post(`${cfg.n8nUrl}/rest/credentials`, {
		data: {
			name: `OpenCloud-unreachable-${Date.now()}`,
			type: 'openCloudApi',
			data: {
				serverUrl: cfg.openCloudUrl,
				user: 'admin',
				password: 'admin',
				skipTlsVerification: true,
			},
		},
	});
	expect(res.status(), `POST /rest/credentials → ${res.status()}: ${await res.text()}`).toBe(200);
	return ((await res.json()) as { data: { id: string } }).data.id;
}

async function importMinimalListWorkflow(
	api: APIRequestContext,
	credId: string,
): Promise<string> {
	const wf = {
		name: `unreachable-${Date.now()}`,
		nodes: [
			{
				parameters: {},
				type: 'n8n-nodes-base.manualTrigger',
				typeVersion: 1,
				position: [200, 300],
				id: 'trigger',
				name: 'When clicking',
			},
			{
				parameters: { resource: 'space', operation: 'list' },
				type: '@opencloud-eu/n8n-nodes-opencloud.openCloud',
				typeVersion: 1,
				position: [400, 300],
				id: 'list',
				name: 'List drives',
				credentials: { openCloudApi: { id: credId } },
			},
		],
		connections: {
			'When clicking': { main: [[{ node: 'List drives', type: 'main', index: 0 }]] },
		},
		settings: {},
	};
	const res = await api.post(`${cfg.n8nUrl}/rest/workflows`, { data: wf });
	expect(res.status(), `POST /rest/workflows → ${res.status()}: ${await res.text()}`).toBe(200);
	return ((await res.json()) as { data: { id: string } }).data.id;
}

async function runFromTrigger(api: APIRequestContext, wfId: string): Promise<string> {
	const res = await api.post(`${cfg.n8nUrl}/rest/workflows/${wfId}/run`, {
		data: { triggerToStartFrom: { name: 'When clicking' } },
	});
	expect(res.status(), `POST /rest/workflows/${wfId}/run → ${res.status()}: ${await res.text()}`).toBe(200);
	return ((await res.json()) as { data: { executionId: string } }).data.executionId;
}

async function pollExecution(
	api: APIRequestContext,
	execId: string,
	timeoutMs: number,
): Promise<{ status: string; errorMessage: string }> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const r = await api.get(`${cfg.n8nUrl}/rest/executions/${execId}`);
		if (r.ok()) {
			const j = (await r.json()) as { data: { status: string; data?: string } };
			const status = j.data.status ?? '';
			if (['success', 'error', 'crashed', 'canceled'].includes(status)) {
				// n8n stores execution data as a string-pool serialization, where
				// the error type and the message string live in separate pool slots.
				// We just need to confirm a clear-text snippet lands somewhere in
				// the blob, so the test passes a substring-match style raw payload
				// back to the caller for assertion.
				const raw = typeof j.data.data === 'string' ? j.data.data : '';
				return { status, errorMessage: raw };
			}
		}
		await new Promise((res) => setTimeout(res, 500));
	}
	throw new Error(`timed out waiting for execution ${execId}`);
}
