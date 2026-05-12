/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OpenCloud } from '../OpenCloud.node';
import {
	makeExecuteFunctions,
	fixtures,
	nock,
	isolateNetwork,
	getPersonalDriveId,
	IS_INTEGRATION,
	mockOnly,
	tmpPath,
	TMP_ROOT,
	nockMeDrives,
} from './helpers';

const { TEST_SERVER } = fixtures;

/**
 * Dual-mode test suite.
 *
 *   pnpm test                                # mock mode (default, fast, hermetic)
 *   OPENCLOUD_URL=https://host.docker.internal:9200 pnpm test
 *                                            # integration: hit a real backend
 *   OPENCLOUD_URL=https://192.168.1.42:9400 \
 *     OPENCLOUD_USER=admin OPENCLOUD_PASSWORD=admin pnpm test
 *
 * Tests that exercise behaviour reproducible in both modes share assertions.
 * Mock-specific cases (error-mapping, cross-storage) use `mockOnly.it(...)` —
 * they auto-skip when OPENCLOUD_URL is set.
 */

const node = new OpenCloud();

describe('OpenCloud node', () => {
	isolateNetwork();

	let driveId: string;
	let driveIdEnc: string;

	beforeAll(async () => {
		// In mock mode this returns the synthetic id immediately. In integration
		// mode it hits /me/drives once and caches the personal-drive id.
		driveId = await getPersonalDriveId();
		driveIdEnc = encodeURIComponent(driveId);
	});

	afterAll(async () => {
		// Integration mode only — sweep the tmp folder created during the run.
		// Mock mode has nothing to clean.
		if (!IS_INTEGRATION) return;
		try {
			const { fns } = makeExecuteFunctions({
				parameters: { resource: 'folder', operation: 'delete', space: driveId, path: TMP_ROOT },
				continueOnFail: true,
			});
			await node.execute.call(fns);
		} catch {
			// Best-effort. If the folder never got created, ignore.
		}
	}, 30_000);

	describe('space:list', () => {
		it('returns at least one drive including the personal one', async () => {
			nockMeDrives();
			const { fns } = makeExecuteFunctions({
				parameters: { resource: 'space', operation: 'list' },
			});
			const result = await node.execute.call(fns);
			expect(result[0].length).toBeGreaterThan(0);
			const drives = result[0].map((it) => it.json) as Array<{ driveType?: string }>;
			expect(drives.some((d) => d.driveType === 'personal')).toBe(true);
		});
	});

	describe('folder lifecycle', () => {
		it('create → list → delete a folder under tmp root', async () => {
			const folderName = `folder-${Date.now()}`;
			const folderPath = tmpPath(folderName);
			const parentItemId = `${driveId}!parent`;
			const subItemId = `${driveId}!sub`;

			// Create
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.intercept(`/dav/spaces/${driveIdEnc}${encodePath(folderPath)}`, 'MKCOL')
					.reply(201);
				// Post-MKCOL path-walk resolves the new folder to a driveItem.
				nockChildrenWalk(
					[{ id: parentItemId, name: TMP_ROOT.slice(1), folder: {} }],
					[{ id: subItemId, name: folderName, folder: {} }],
				);
			}
			if (IS_INTEGRATION) await ensureFolder(driveId, TMP_ROOT);
			const createdSub = await runCreate(driveId, TMP_ROOT, folderName);
			expect(createdSub).toMatchObject({ name: folderName, folder: {} });
			expect(typeof createdSub.id).toBe('string');

			// List parent — folder should appear
			if (!IS_INTEGRATION) {
				nockChildrenWalk([{ id: parentItemId, name: TMP_ROOT.slice(1), folder: {} }]);
				nock(TEST_SERVER)
					.get(`/graph/v1.0/drives/${driveIdEnc}/items/${encodeURIComponent(parentItemId)}/children`)
					.reply(200, { value: [{ id: subItemId, name: folderName, folder: {} }] });
			}
			const { fns: listFns } = makeExecuteFunctions({
				parameters: { resource: 'folder', operation: 'list', space: driveId, path: TMP_ROOT },
			});
			const listed = await node.execute.call(listFns);
			const names = listed[0].map((it) => (it.json as { name?: string }).name);
			expect(names).toContain(folderName);

			// Delete
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER).delete(`/dav/spaces/${driveIdEnc}${encodePath(folderPath)}`).reply(204);
			}
			const { fns: delFns } = makeExecuteFunctions({
				parameters: { resource: 'folder', operation: 'delete', space: driveId, path: folderPath },
			});
			const deleted = await node.execute.call(delFns);
			expect(deleted[0][0].json).toEqual({});
		});
	});

	describe('file lifecycle (text content)', () => {
		it('upload → list → download → delete', async () => {
			const fileName = `hello-${Date.now()}.txt`;
			const filePath = tmpPath(fileName);
			const content = `hello opencloud ${new Date().toISOString()}\n`;

			if (IS_INTEGRATION) await ensureFolder(driveId, TMP_ROOT);

			// Upload
			const parentItemId = `${driveId}!parent`;
			const fileItemId = `${driveId}!file`;
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.put(`/dav/spaces/${driveIdEnc}${encodePath(filePath)}`, content)
					.matchHeader('Content-Type', 'text/plain; charset=utf-8')
					.reply(201);
				nockChildrenWalk(
					[{ id: parentItemId, name: TMP_ROOT.slice(1), folder: {} }],
					[{ id: fileItemId, name: fileName, file: { mimeType: 'text/plain' } }],
				);
			}
			const uploaded = await runOnceJson({
				resource: 'file',
				operation: 'upload',
				space: driveId,
				path: TMP_ROOT,
				name: fileName,
				binaryDataUpload: false,
				fileContent: content,
			});
			expect(uploaded).toMatchObject({ name: fileName, file: { mimeType: 'text/plain' } });
			expect(typeof uploaded.id).toBe('string');

			// Download mirrors MS Graph GET /content: bytes only, no driveItem in json.
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.get(`/dav/spaces/${driveIdEnc}${encodePath(filePath)}`)
					.reply(200, Buffer.from(content), { 'Content-Type': 'text/plain' });
			}
			const { fns: dlFns } = makeExecuteFunctions({
				parameters: {
					resource: 'file',
					operation: 'download',
					space: driveId,
					path: filePath,
					binaryProperty: 'data',
				},
			});
			const downloaded = await node.execute.call(dlFns);
			const binary = downloaded[0][0].binary as Record<string, { data: string }>;
			expect(Buffer.from(binary.data.data, 'base64').toString('utf8')).toBe(content);

			// Delete
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER).delete(`/dav/spaces/${driveIdEnc}${encodePath(filePath)}`).reply(204);
			}
			await runOnceJson({
				resource: 'file',
				operation: 'delete',
				space: driveId,
				path: filePath,
			});
		});
	});

	describe('file:upload (binary)', () => {
		it('PUTs the binary buffer as application/octet-stream', async () => {
			const fileName = `image-${Date.now()}.png`;
			const filePath = tmpPath(fileName);
			const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

			if (IS_INTEGRATION) await ensureFolder(driveId, TMP_ROOT);
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.put(`/dav/spaces/${driveIdEnc}${encodePath(filePath)}`)
					.matchHeader('Content-Type', 'application/octet-stream')
					.reply(201);
				nockChildrenWalk(
					[{ id: `${driveId}!parent`, name: TMP_ROOT.slice(1), folder: {} }],
					[{ id: `${driveId}!img`, name: fileName, file: { mimeType: 'image/png' } }],
				);
			}
			const { fns } = makeExecuteFunctions({
				parameters: {
					resource: 'file',
					operation: 'upload',
					space: driveId,
					path: TMP_ROOT,
					name: fileName,
					binaryDataUpload: true,
					binaryProperty: 'data',
				},
				inputBinary: { property: 'data', data: buf, mimeType: 'image/png' },
			});
			await node.execute.call(fns);

			// Cleanup in integration mode
			if (IS_INTEGRATION) await runOnceJson({
				resource: 'file', operation: 'delete', space: driveId, path: filePath,
			});
		});
	});

	describe('file:copy + move', () => {
		it('copy then rename within tmp root', async () => {
			if (IS_INTEGRATION) await ensureFolder(driveId, TMP_ROOT);
			const srcName = `src-${Date.now()}.txt`;
			const srcPath = tmpPath(srcName);
			const copyPath = tmpPath('copy.txt');
			const renamedPath = tmpPath('renamed.txt');

			// Pre-create source in integration mode
			if (IS_INTEGRATION) {
				await runOnceJson({
					resource: 'file', operation: 'upload', space: driveId,
					path: TMP_ROOT, name: srcName,
					binaryDataUpload: false, fileContent: 'src',
				});
			}
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.intercept(`/dav/spaces/${driveIdEnc}${encodePath(srcPath)}`, 'COPY')
					.matchHeader('Destination', `${TEST_SERVER}/dav/spaces/${driveIdEnc}${encodePath(copyPath)}`)
					.reply(201);
				nockChildrenWalk(
					[{ id: `${driveId}!parent`, name: TMP_ROOT.slice(1), folder: {} }],
					[{ id: `${driveId}!copy`, name: 'copy.txt', file: { mimeType: 'text/plain' } }],
				);
			}
			const copied = await runOnceJson({
				resource: 'file', operation: 'copy', space: driveId,
				path: srcPath, destSpace: '', destParentPath: TMP_ROOT, destName: 'copy.txt',
			});
			expect(copied).toMatchObject({ name: 'copy.txt', file: { mimeType: 'text/plain' } });

			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.intercept(`/dav/spaces/${driveIdEnc}${encodePath(copyPath)}`, 'MOVE')
					.matchHeader('Destination', `${TEST_SERVER}/dav/spaces/${driveIdEnc}${encodePath(renamedPath)}`)
					.reply(201);
				nockChildrenWalk(
					[{ id: `${driveId}!parent`, name: TMP_ROOT.slice(1), folder: {} }],
					[{ id: `${driveId}!ren`, name: 'renamed.txt', file: { mimeType: 'text/plain' } }],
				);
			}
			await runOnceJson({
				resource: 'file', operation: 'move', space: driveId,
				path: copyPath, destSpace: '', destParentPath: TMP_ROOT, destName: 'renamed.txt',
			});

			// Cleanup integration leftovers (afterAll sweeps the whole tmp root anyway,
			// but explicit deletes keep the test self-contained when running standalone).
			if (IS_INTEGRATION) {
				for (const p of [srcPath, renamedPath]) {
					await runOnceJson({
						resource: 'file', operation: 'delete', space: driveId, path: p,
					}).catch(() => null);
				}
			}
		});
	});

	describe('file:share (createLink)', () => {
		it('creates a public view link for an item', async () => {
			const fileName = `share-${Date.now()}.txt`;
			const filePath = tmpPath(fileName);

			if (IS_INTEGRATION) {
				await ensureFolder(driveId, TMP_ROOT);
				await runOnceJson({
					resource: 'file', operation: 'upload', space: driveId,
					path: TMP_ROOT, name: fileName,
					binaryDataUpload: false, fileContent: 'share me',
				});
			}

			if (!IS_INTEGRATION) {
				// Mock the path-walk + createLink call
				const itemId = `${driveId}!share-item`;
				nockChildrenWalk(
					[
						{ id: `${driveId}!parent`, name: TMP_ROOT.slice(1), folder: {} },
					],
					[
						{ id: itemId, name: fileName, file: { mimeType: 'text/plain' } },
					],
				);
				nock(TEST_SERVER)
					.post(`/graph/v1beta1/drives/${driveIdEnc}/items/${encodeURIComponent(itemId)}/createLink`, {
						type: 'view',
					})
					.reply(200, {
						id: 'perm-abc',
						link: { type: 'view', webUrl: `${TEST_SERVER}/s/abc123` },
					});
			}

			const { fns } = makeExecuteFunctions({
				parameters: {
					resource: 'file', operation: 'share', space: driveId,
					path: filePath, linkType: 'view', password: '', expirationDateTime: '',
				},
			});
			let result;
			try {
				result = await node.execute.call(fns);
			} catch (err) {
				// If the integration server enforces password on view links, the node
				// throws our "set password" hint. That's a server-policy fact, not a
				// node bug — accept it as a pass for integration mode.
				if (IS_INTEGRATION && /password/i.test((err as Error).message)) return;
				throw err;
			}
			expect(result![0][0].json).toMatchObject({
				link: expect.objectContaining({ type: 'view' }),
			});

			// Cleanup
			if (IS_INTEGRATION) {
				await runOnceJson({
					resource: 'file', operation: 'delete', space: driveId, path: filePath,
				}).catch(() => null);
			}
		});
	});

	describe('user CRUD', () => {
		it('lists users', async () => {
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.get('/graph/v1.0/users')
					.reply(200, {
						value: [
							{ id: 'u1', displayName: 'Admin', onPremisesSamAccountName: 'admin' },
						],
					});
			}
			const { fns } = makeExecuteFunctions({
				parameters: { resource: 'user', operation: 'getAll' },
			});
			const result = await node.execute.call(fns);
			expect(result[0].length).toBeGreaterThan(0);
			const first = result[0][0].json as { id?: string; onPremisesSamAccountName?: string };
			expect(first.id).toBeTruthy();
		});

		it('full create → get → update → delete cycle', async () => {
			const userName = `n8n-test-${Date.now()}`;
			const email = `${userName}@example.com`;

			if (!IS_INTEGRATION) {
				const userId = 'mock-user-id';
				nock(TEST_SERVER)
					.post('/graph/v1.0/users', {
						onPremisesSamAccountName: userName,
						displayName: 'n8n Test User',
						mail: email,
						passwordProfile: { password: 'Smoke!Test123' },
					})
					.reply(201, { id: userId, displayName: 'n8n Test User', onPremisesSamAccountName: userName, mail: email })
					.get(`/graph/v1.0/users/${userId}`)
					.reply(200, { id: userId, displayName: 'n8n Test User', onPremisesSamAccountName: userName, mail: email })
					.patch(`/graph/v1.0/users/${userId}`, { displayName: 'Renamed' })
					.reply(200, { id: userId, displayName: 'Renamed', onPremisesSamAccountName: userName, mail: email })
					.delete(`/graph/v1.0/users/${userId}`)
					.reply(204);
			}

			// Create
			const created = (await runOnceJson({
				resource: 'user',
				operation: 'create',
				userName,
				displayName: 'n8n Test User',
				email,
				password: 'Smoke!Test123',
			})) as { id?: string; displayName?: string };
			expect(created.id).toBeTruthy();
			expect(created.displayName).toBe('n8n Test User');

			// Get
			const fetched = (await runOnceJson({
				resource: 'user',
				operation: 'get',
				userId: created.id,
			})) as { id?: string; onPremisesSamAccountName?: string };
			expect(fetched.id).toBe(created.id);

			// Update (Libre Graph returns the updated user; we pass it through).
			const updated = (await runOnceJson({
				resource: 'user',
				operation: 'update',
				userId: created.id,
				updateFields: { displayName: 'Renamed' },
			})) as { id?: string; displayName?: string };
			expect(updated.id).toBe(created.id);
			if (!IS_INTEGRATION) expect(updated.displayName).toBe('Renamed');

			// Delete (Libre Graph returns 204 No Content; we expose {}).
			const deleted = await runOnceJson({
				resource: 'user',
				operation: 'delete',
				userId: created.id,
			});
			expect(deleted).toEqual({});
		});
	});

	// --- Mock-only tests below: error-path simulation that can't be reliably
	// reproduced against an arbitrary real server. ---

	describe('error mapping (mock-only)', () => {
		mockOnly.it('cross-storage 502 → friendly NodeApiError', async () => {
			nock(TEST_SERVER)
				.intercept(`/dav/spaces/${driveIdEnc}/Personal/x.txt`, 'MOVE')
				.reply(502, 'Bad gateway');

			const { fns } = makeExecuteFunctions({
				parameters: {
					resource: 'file', operation: 'move', space: driveId,
					path: '/Personal/x.txt',
					destSpace: 'storage-users-2$other-space',
					destParentPath: '/Other', destName: '',
				},
			});
			await expect(node.execute.call(fns)).rejects.toThrow(/Cross-storage move/);
		});

		mockOnly.it('share 400 + no password + non-internal → "set password" hint', async () => {
			const itemId = `${driveId}!report`;
			nockChildrenWalk(
				[{ id: `${driveId}!docs`, name: 'Documents', folder: {} }],
				[{ id: itemId, name: 'report.pdf', file: { mimeType: 'application/pdf' } }],
			);
			nock(TEST_SERVER)
				.post(`/graph/v1beta1/drives/${driveIdEnc}/items/${encodeURIComponent(itemId)}/createLink`)
				.reply(400, { error: { message: 'password protection is enforced' } });

			const { fns } = makeExecuteFunctions({
				parameters: {
					resource: 'file', operation: 'share', space: driveId,
					path: '/Documents/report.pdf',
					linkType: 'view', password: '', expirationDateTime: '',
				},
			});
			await expect(node.execute.call(fns)).rejects.toThrow(
				/This link type requires a password on the server/,
			);
		});

		mockOnly.it('cross-space folder COPY (mock — depends on a second drive)', async () => {
			const otherDriveId = 'storage-users-2$other-space-id';
			const otherDriveEnc = encodeURIComponent(otherDriveId);
			nock(TEST_SERVER)
				.intercept(`/dav/spaces/${driveIdEnc}/Documents/Reports`, 'COPY')
				.matchHeader('Destination', `${TEST_SERVER}/dav/spaces/${otherDriveEnc}/Shared/Reports`)
				.reply(201)
				// Post-COPY path-walk on the destination drive.
				.get(`/graph/v1.0/drives/${otherDriveEnc}/items/${otherDriveEnc}/children`)
				.reply(200, { value: [{ id: `${otherDriveId}!shared`, name: 'Shared', folder: {} }] })
				.get(`/graph/v1.0/drives/${otherDriveEnc}/items/${encodeURIComponent(`${otherDriveId}!shared`)}/children`)
				.reply(200, { value: [{ id: `${otherDriveId}!reports`, name: 'Reports', folder: {} }] });
			await runOnceJson({
				resource: 'folder', operation: 'copy', space: driveId,
				path: '/Documents/Reports',
				destSpace: otherDriveId,
				destParentPath: '/Shared', destName: '',
			});
		});
	});

	// --- Helpers private to this file ---

	/** Encode a file path the same way the node does: encode each segment. */
	function encodePath(p: string): string {
		return p.split('/').map(encodeURIComponent).join('/');
	}

	/** Run a single op and return the first output's json. */
	async function runOnceJson(parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { fns } = makeExecuteFunctions({ parameters });
		const result = (await node.execute.call(fns)) as Array<Array<{ json: Record<string, unknown> }>>;
		return result[0][0].json;
	}

	async function runCreate(spaceId: string, parent: string, name: string) {
		return runOnceJson({
			resource: 'folder', operation: 'create', space: spaceId, path: parent, name,
		});
	}

	/** Idempotent folder creation — used in integration setup. */
	async function ensureFolder(spaceId: string, path: string) {
		const segments = path.split('/').filter(Boolean);
		let parent = '';
		for (const seg of segments) {
			try {
				await runCreate(spaceId, parent, seg);
			} catch {
				// 405 Method Not Allowed = already exists; ignore.
			}
			parent = parent ? `${parent}/${seg}` : `/${seg}`;
		}
	}

	/**
	 * Mock helper — sets up nock interceptors for the children-walk that
	 * `resolvePathToItemId` performs. Each level returns the children listed
	 * in the corresponding step. Caller is responsible for calling this from
	 * mock-mode tests only.
	 */
	function nockChildrenWalk(...steps: Array<Array<{ id: string; name: string; folder?: object; file?: object }>>) {
		let parentId = driveId;
		for (const children of steps) {
			nock(TEST_SERVER)
				.get(`/graph/v1.0/drives/${driveIdEnc}/items/${encodeURIComponent(parentId)}/children`)
				.reply(200, { value: children });
			// Drop into the last child for the next level (matches resolvePathToItemId)
			const last = children[children.length - 1];
			parentId = last.id;
		}
	}
});
