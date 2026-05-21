/* eslint-disable @n8n/community-nodes/no-restricted-imports, @n8n/community-nodes/no-restricted-globals */
// Test-only imports — vitest, nock, axios are devDependencies that don't ship
// at runtime, so the n8n-cloud "no extra runtime deps" rule doesn't apply.
import { vi, beforeEach, afterEach, beforeAll, it as vitestIt } from 'vitest';
import { mock } from 'vitest-mock-extended';
import nock from 'nock';
import axios, { type AxiosRequestConfig, type ResponseType } from 'axios';
import https from 'node:https';
import type {
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
} from 'n8n-workflow';

/**
 * Mode switch driven entirely by env vars:
 *
 *   OPENCLOUD_URL       set → INTEGRATION mode (real backend, no nock interception)
 *                       unset → MOCK mode (fast, hermetic, default for CI)
 *   OPENCLOUD_USER      default 'admin'    (OpenCloud dev seed user)
 *   OPENCLOUD_PASSWORD  default 'admin'
 *
 * Same test file works in both modes. Mock-only test cases are tagged with
 * `mockOnly.it(...)` so they auto-skip against a real backend. Integration
 * runs use a tmp folder per process so concurrent runs don't collide.
 */
const INTEGRATION_URL = (process.env.OPENCLOUD_URL ?? '').trim();
export const IS_INTEGRATION = INTEGRATION_URL.length > 0;
const MOCK_SERVER = 'https://opencloud.test';

export const fixtures = {
	/** Server URL — the real backend in integration mode, a synthetic .test host otherwise. */
	TEST_SERVER: IS_INTEGRATION ? INTEGRATION_URL : MOCK_SERVER,
	/** Synthetic drive id used for mock-mode tests AND for the mock /me/drives reply. */
	MOCK_DRIVE: 'storage-users-1$00000000-0000-0000-0000-000000000001',
	get MOCK_DRIVE_ENC() {
		return encodeURIComponent(this.MOCK_DRIVE);
	},
};

const credentials = {
	serverUrl: fixtures.TEST_SERVER,
	user: process.env.OPENCLOUD_USER ?? 'admin',
	password: process.env.OPENCLOUD_PASSWORD ?? 'admin',
};

/** Unique per-process tmp path so concurrent integration runs don't collide. */
const TMP_PREFIX = `/n8n-test-${process.pid}-${Date.now()}`;
export function tmpPath(...segments: string[]): string {
	return [TMP_PREFIX, ...segments].join('/');
}
export const TMP_ROOT = TMP_PREFIX;

/**
 * `it.skipIf(IS_INTEGRATION)` shorthand for tests that only make sense
 * against mocked HTTP (error-path simulation, cross-storage edge cases,
 * specific-mock-data assertions).
 */
export const mockOnly = {
	it: IS_INTEGRATION ? vitestIt.skip : vitestIt,
};

/** Cached personal-drive id so we only resolve it once per test run. */
let cachedPersonalDriveId: string | undefined;

/**
 * Returns a drive id usable in both modes:
 *   - mock: a stable synthetic id (callers separately set up a nock interceptor
 *     for /me/drives if they exercise space:list)
 *   - integration: the user's real personal drive, looked up once
 */
export async function getPersonalDriveId(): Promise<string> {
	if (!IS_INTEGRATION) return fixtures.MOCK_DRIVE;
	if (cachedPersonalDriveId) return cachedPersonalDriveId;

	const res = await axios.get(`${INTEGRATION_URL}/graph/v1.0/me/drives`, {
		auth: { username: credentials.user, password: credentials.password },
		httpsAgent: new https.Agent({ rejectUnauthorized: false }),
		validateStatus: () => true,
	});
	if (res.status !== 200) {
		throw new Error(
			`Could not list drives at ${INTEGRATION_URL} (HTTP ${res.status}). ` +
				`Check OPENCLOUD_URL/USER/PASSWORD env vars.`,
		);
	}
	const drives = (res.data as { value?: Array<{ id?: string; driveType?: string }> }).value ?? [];
	const personal = drives.find((d) => d.driveType === 'personal');
	if (!personal?.id) {
		throw new Error(
			`No personal drive on ${INTEGRATION_URL}. Drive types found: ` +
				drives.map((d) => d.driveType ?? '<none>').join(', '),
		);
	}
	cachedPersonalDriveId = personal.id;
	return personal.id;
}

/**
 * Builds the axios-backed `httpRequestWithAuthentication` mock shared by both
 * IExecuteFunctions and ILoadOptionsFunctions helper factories. Nock intercepts
 * at the wire in mock mode; integration mode reaches the real backend.
 *
 * Honors `encoding: 'arraybuffer'` so binary downloads return a Buffer.
 */
function buildRequestSpy() {
	return vi.fn(async (_credType: string, options: IHttpRequestOptions) => {
		const axiosConfig: AxiosRequestConfig = {
			method: options.method,
			url: options.url,
			headers: { ...(options.headers as Record<string, string>) },
			params: options.qs,
			data: options.body,
			auth: { username: credentials.user, password: credentials.password },
			validateStatus: () => true,
			httpsAgent: new https.Agent({ rejectUnauthorized: false }),
		};
		if (options.encoding) axiosConfig.responseType = options.encoding as ResponseType;

		const res = await axios.request(axiosConfig);

		if (res.status >= 200 && res.status < 300) {
			if (options.encoding === 'arraybuffer') return Buffer.from(res.data as ArrayBuffer);
			return res.data;
		}

		const inner = (res.data as { error?: { message?: string } })?.error?.message;
		const e: Error & { httpCode?: number; description?: string } = new Error(
			`HTTP ${res.status}`,
		);
		e.httpCode = res.status;
		if (inner) e.description = inner;
		throw e;
	});
}

/**
 * Builds a mocked IExecuteFunctions wired to fire real axios calls, so nock
 * intercepts at the wire (mock mode) or requests pass through to the real
 * backend (integration mode).
 */
export function makeExecuteFunctions(opts: {
	parameters: Record<string, unknown>;
	inputBinary?: { property: string; data: Buffer; mimeType?: string; fileName?: string };
	continueOnFail?: boolean;
}) {
	const fns = mock<IExecuteFunctions>();

	fns.getNodeParameter.mockImplementation(
		(name: string, _itemIndex: number, fallback?: unknown, options?: { extractValue?: boolean }) => {
			if (!(name in opts.parameters)) return fallback;
			const raw = opts.parameters[name];
			// Mirror n8n's runtime behavior: with extractValue: true, a
			// resourceLocator-shaped value ({__rl, mode, value}) unwraps to .value.
			// Bare strings pass through unchanged.
			if (options?.extractValue && raw !== null && typeof raw === 'object' && (raw as { __rl?: boolean }).__rl === true) {
				return (raw as { value?: unknown }).value;
			}
			return raw;
		},
	);

	fns.getCredentials.mockResolvedValue(credentials);

	const inputItem = opts.inputBinary
		? {
				json: {},
				binary: {
					[opts.inputBinary.property]: {
						data: opts.inputBinary.data.toString('base64'),
						mimeType: opts.inputBinary.mimeType ?? 'application/octet-stream',
						fileName: opts.inputBinary.fileName ?? 'input',
					},
				},
			}
		: { json: {} };
	fns.getInputData.mockReturnValue([inputItem as never]);

	fns.continueOnFail.mockReturnValue(opts.continueOnFail ?? false);
	fns.getNode.mockReturnValue({
		id: 'test-node',
		name: 'OpenCloud',
		type: '@opencloud-eu/n8n-nodes-opencloud.openCloud',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	} as INode);

	const requestSpy = buildRequestSpy();

	const helpers = {
		httpRequestWithAuthentication: requestSpy,
		assertBinaryData: () => {
			if (!opts.inputBinary) throw new Error('No binary data on input item');
		},
		getBinaryDataBuffer: async () => {
			if (!opts.inputBinary) throw new Error('No binary data on input item');
			return opts.inputBinary.data;
		},
		prepareBinaryData: async (buffer: Buffer, fileName?: string, mimeType?: string) => ({
			data: buffer.toString('base64'),
			fileName: fileName ?? 'output',
			mimeType: mimeType ?? 'application/octet-stream',
		}),
	};
	(fns as unknown as { helpers: typeof helpers }).helpers = helpers;

	return { fns, requestSpy };
}

/**
 * Builds a mocked ILoadOptionsFunctions for testing loadOptions methods
 * (getShareRoles, getRecipients, etc). Wires the same axios-backed request
 * spy as makeExecuteFunctions so nock intercepts at the wire.
 *
 * `currentParameters` populates `getCurrentNodeParameter` (the n8n API
 * loadOptions uses to read sibling fields like the current resource type or
 * recipient type).
 */
export function makeLoadOptionsFunctions(opts: {
	currentParameters?: Record<string, unknown>;
}) {
	const fns = mock<ILoadOptionsFunctions>();

	fns.getCurrentNodeParameter.mockImplementation((name: string) => {
		return opts.currentParameters?.[name];
	});
	fns.getCredentials.mockResolvedValue(credentials);
	fns.getNode.mockReturnValue({
		id: 'test-node',
		name: 'OpenCloud',
		type: '@opencloud-eu/n8n-nodes-opencloud.openCloud',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	} as INode);

	const requestSpy = buildRequestSpy();
	(fns as unknown as { helpers: { httpRequestWithAuthentication: typeof requestSpy } }).helpers = {
		httpRequestWithAuthentication: requestSpy,
	};

	return { fns, requestSpy };
}

/**
 * In mock mode, blocks accidental real network calls + cleans interceptors
 * between tests. In integration mode, allows the network through; nock is
 * still cleaned each test so leftover interceptors from a mockOnly test
 * don't affect a following integration-friendly test.
 */
export function isolateNetwork(): void {
	beforeEach(() => {
		if (!IS_INTEGRATION) nock.disableNetConnect();
	});
	afterEach(() => {
		nock.cleanAll();
		nock.enableNetConnect();
	});
}

/** Convenience: run a node operation once and return the first output item's json. */
export async function runOnce<T = Record<string, unknown>>(
	node: { execute: (this: IExecuteFunctions) => Promise<unknown> },
	parameters: Record<string, unknown>,
	extra?: { inputBinary?: { property: string; data: Buffer; mimeType?: string; fileName?: string } },
): Promise<T> {
	const { fns } = makeExecuteFunctions({ parameters, ...extra });
	const result = (await node.execute.call(fns as never)) as Array<Array<{ json: T }>>;
	return result[0]?.[0]?.json as T;
}

/**
 * Mock helper that registers /me/drives → returns the synthetic drive.
 * No-op in integration mode (real /me/drives is hit instead).
 */
export function nockMeDrives(): void {
	if (IS_INTEGRATION) return;
	nock(MOCK_SERVER)
		.get('/graph/v1.0/me/drives')
		.reply(200, {
			value: [{ id: fixtures.MOCK_DRIVE, name: 'Personal', driveType: 'personal' }],
		});
}

/** Re-export shapes used by tests. */
export { nock, beforeAll };
