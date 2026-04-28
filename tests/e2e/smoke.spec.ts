/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * End-to-end smoke test.
 *
 * Logs into the local n8n (the docker compose stack from this repo), creates
 * an OpenCloud credential, imports the example smoke workflow patched with
 * that credential id, runs it from the manual trigger, and asserts the
 * execution finished with `status: 'success'`.
 *
 * Prereqs:
 *   - `docker compose up` from this repo (n8n bound at N8N_URL with the dev
 *     owner auto-provisioned by N8N_INSTANCE_OWNER_MANAGED_BY_ENV).
 *   - A reachable OpenCloud server with admin write access to the personal
 *     drive of OPENCLOUD_USER.
 *
 * Env vars:
 *   OPENCLOUD_URL       required — e.g. https://host.docker.internal:9200
 *   OPENCLOUD_USER      default 'admin'
 *   OPENCLOUD_PASSWORD  default 'admin'
 *   N8N_URL             default 'http://localhost:5678'
 *   N8N_EMAIL           default 'admin@example.com'
 *   N8N_PASSWORD        default 'admin'
 */

const cfg = {
	openCloudUrl: process.env.OPENCLOUD_URL ?? '',
	openCloudUser: process.env.OPENCLOUD_USER ?? 'admin',
	openCloudPassword: process.env.OPENCLOUD_PASSWORD ?? 'admin',
	n8nUrl: process.env.N8N_URL ?? 'http://localhost:5678',
	n8nEmail: process.env.N8N_EMAIL ?? 'admin@example.com',
	n8nPassword: process.env.N8N_PASSWORD ?? 'admin',
};

test.skip(!cfg.openCloudUrl, 'OPENCLOUD_URL is required for the e2e smoke test');

test.describe('OpenCloud node — end-to-end smoke', () => {
	test('runs the example smoke workflow against a real OpenCloud', async ({
		page,
		context,
	}) => {
		// n8n requires a `browser-id` header on every REST call (a UUID the
		// frontend generates client-side and reuses across the session).
		const browserId = randomUUID();
		await context.setExtraHTTPHeaders({ 'browser-id': browserId });

		await test.step('log in', async () => {
			await page.goto(`${cfg.n8nUrl}/signin`, { waitUntil: 'domcontentloaded' });
			await page.getByRole('textbox', { name: /email/i }).fill(cfg.n8nEmail);
			await page.getByRole('textbox', { name: /password/i }).fill(cfg.n8nPassword);
			await Promise.all([
				page.waitForURL((u) => !/\/signin\b/.test(u.toString()), { timeout: 15_000 }),
				page.getByRole('button', { name: /sign in/i }).click(),
			]);
		});

		const api = page.request;
		const credId = await test.step('create OpenCloud credential', async () =>
			createCredential(api, cfg));

		const wfId = await test.step('import patched smoke workflow', async () =>
			importPatchedWorkflow(api, cfg, credId));

		const execId = await test.step('run from manual trigger', async () =>
			runFromManualTrigger(api, cfg, wfId));

		const finalStatus = await test.step('wait for execution to finish', async () =>
			pollExecution(api, cfg, execId, 60_000));

		expect(finalStatus, `execution ${execId} ended with non-success status`).toBe('success');
	});
});

// --- helpers ---------------------------------------------------------------

async function createCredential(api: APIRequestContext, c: typeof cfg): Promise<string> {
	const res = await api.post(`${c.n8nUrl}/rest/credentials`, {
		data: {
			name: `OpenCloud (e2e ${Date.now()})`,
			type: 'openCloudApi',
			data: {
				serverUrl: c.openCloudUrl,
				user: c.openCloudUser,
				password: c.openCloudPassword,
				// Dev OpenCloud is typically self-signed.
				skipTlsVerification: true,
			},
		},
	});
	expect(res.status(), `POST /rest/credentials → ${res.status()}: ${await res.text()}`).toBe(200);
	const body = (await res.json()) as { data: { id: string } };
	return body.data.id;
}

async function importPatchedWorkflow(
	api: APIRequestContext,
	c: typeof cfg,
	credId: string,
): Promise<string> {
	const patcher = path.resolve(process.cwd(), 'examples', 'apply-credentials.sh');
	const patched = execFileSync(patcher, [credId]).toString();
	const wf = JSON.parse(patched) as {
		name: string;
		nodes: unknown[];
		connections: unknown;
		settings?: unknown;
	};

	const res = await api.post(`${c.n8nUrl}/rest/workflows`, {
		data: {
			name: wf.name,
			nodes: wf.nodes,
			connections: wf.connections,
			settings: wf.settings ?? {},
		},
	});
	expect(res.status(), `POST /rest/workflows → ${res.status()}: ${await res.text()}`).toBe(200);
	const body = (await res.json()) as { data: { id: string } };
	return body.data.id;
}

async function runFromManualTrigger(
	api: APIRequestContext,
	c: typeof cfg,
	wfId: string,
): Promise<string> {
	// Find the manual-trigger node from the imported JSON to feed it as
	// triggerToStartFrom (n8n's run endpoint expects this discriminated payload).
	const wfRes = await api.get(`${c.n8nUrl}/rest/workflows/${wfId}`);
	const wfJson = (await wfRes.json()) as {
		data: { nodes: Array<{ name: string; type: string }> };
	};
	const trigger = wfJson.data.nodes.find((n) => n.type === 'n8n-nodes-base.manualTrigger');
	expect(trigger, 'workflow has no manualTrigger node').toBeDefined();

	const res = await api.post(`${c.n8nUrl}/rest/workflows/${wfId}/run`, {
		data: { triggerToStartFrom: { name: trigger!.name } },
	});
	expect(res.status(), `POST /rest/workflows/${wfId}/run → ${res.status()}: ${await res.text()}`).toBe(200);
	const body = (await res.json()) as { data: { executionId: string } };
	return body.data.executionId;
}

async function pollExecution(
	api: APIRequestContext,
	c: typeof cfg,
	execId: string,
	timeoutMs: number,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let status = '';
	while (Date.now() < deadline) {
		const r = await api.get(`${c.n8nUrl}/rest/executions/${execId}`);
		if (r.ok()) {
			const j = (await r.json()) as { data: { status: string; data?: string } };
			status = j.data.status ?? '';
			if (['success', 'error', 'crashed', 'canceled'].includes(status)) {
				if (status !== 'success') {
					// n8n stores execution data as a serialized graph (string-pool format).
					// Surface the topmost error message in the assertion failure text.
					const raw = typeof j.data.data === 'string' ? j.data.data : '';
					const match = raw.match(
						/"name":"NodeApiError|NodeOperationError"[\s\S]{0,400}?"message":"([^"]+)"/,
					);
					if (match) {
						test.info().annotations.push({ type: 'execution-error', description: match[1] });
					}
				}
				return status;
			}
		}
		await new Promise((res) => setTimeout(res, 1000));
	}
	throw new Error(`timed out waiting for execution ${execId}; last status '${status}'`);
}
