/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OpenCloud } from '../OpenCloud.node';
import {
	makeExecuteFunctions,
	makeLoadOptionsFunctions,
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

			// Create
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.intercept(`/dav/spaces/${driveIdEnc}${encodePath(TMP_ROOT)}`, 'MKCOL')
					.optionally()
					.reply(201)
					.intercept(`/dav/spaces/${driveIdEnc}${encodePath(folderPath)}`, 'MKCOL')
					.reply(201);
			}
			// Make sure the parent exists in integration mode (idempotent).
			if (IS_INTEGRATION) await ensureFolder(driveId, TMP_ROOT);
			const created = await runCreate(driveId, '', TMP_ROOT.slice(1)).catch(() => null); // ok if exists
			void created;
			const createdSub = await runCreate(driveId, TMP_ROOT, folderName);
			expect(createdSub).toMatchObject({ success: true, name: folderName });

			// List parent — folder should appear
			if (!IS_INTEGRATION) {
				// Mock the path-walk + children listing
				nockChildrenWalk([{ id: `${driveId}!parent`, name: TMP_ROOT.slice(1), folder: {} }]);
				nock(TEST_SERVER)
					.get(`/graph/v1.0/drives/${driveIdEnc}/items/${encodeURIComponent(`${driveId}!parent`)}/children`)
					.reply(200, { value: [{ id: 'child', name: folderName, folder: {} }] });
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
			expect(deleted[0][0].json).toMatchObject({ success: true, path: folderPath });
		});
	});

	describe('file lifecycle (text content)', () => {
		it('upload → list → download → delete', async () => {
			const fileName = `hello-${Date.now()}.txt`;
			const filePath = tmpPath(fileName);
			const content = `hello opencloud ${new Date().toISOString()}\n`;

			if (IS_INTEGRATION) await ensureFolder(driveId, TMP_ROOT);

			// Upload
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.put(`/dav/spaces/${driveIdEnc}${encodePath(filePath)}`, content)
					.matchHeader('Content-Type', 'text/plain; charset=utf-8')
					.reply(201);
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
			expect(uploaded).toMatchObject({ success: true, name: fileName });

			// Download
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
			}
			await runOnceJson({
				resource: 'file', operation: 'copy', space: driveId,
				path: srcPath, destSpace: '', destParentPath: TMP_ROOT, destName: 'copy.txt',
			});

			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.intercept(`/dav/spaces/${driveIdEnc}${encodePath(copyPath)}`, 'MOVE')
					.matchHeader('Destination', `${TEST_SERVER}/dav/spaces/${driveIdEnc}${encodePath(renamedPath)}`)
					.reply(201);
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
					recipientType: 'publicLink',
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

	describe('share: invite via unified roles', () => {
		// Dual-mode invites. Mock mode uses nock body-match fixtures (tight
		// shape assertion). Integration mode resolves a seeded demo recipient
		// by displayName (so an LDIF seed regen doesn't break CI), fetches a
		// real role applicable to the resource type, invites, asserts the
		// returned Permission shape, and cleans up. file/folder cleanups
		// delete the parent (cascades the permission); the space test creates
		// a tmp project space and two-step disable+purges it so CI runs leave
		// no trash.

		async function liveGet<T = unknown>(path: string): Promise<T> {
			const { fns } = makeExecuteFunctions({ parameters: {} });
			const call = fns.helpers.httpRequestWithAuthentication as (
				cred: string,
				opts: { method: string; url: string; json: boolean },
			) => Promise<T>;
			return call.call(null, 'openCloudApi', {
				method: 'GET',
				url: `${TEST_SERVER}${path}`,
				json: true,
			});
		}

		async function liveUserId(displayName: string): Promise<string> {
			const r = await liveGet<{ value?: Array<{ id?: string; displayName?: string }> }>(
				'/graph/v1.0/users',
			);
			const m = (r.value ?? []).find((u) => u.displayName === displayName);
			if (!m?.id) throw new Error(`No demo user with displayName='${displayName}'`);
			return m.id;
		}
		async function liveGroupId(displayName: string): Promise<string> {
			const r = await liveGet<{ value?: Array<{ id?: string; displayName?: string }> }>(
				'/graph/v1.0/groups',
			);
			const m = (r.value ?? []).find((g) => g.displayName === displayName);
			if (!m?.id) throw new Error(`No demo group with displayName='${displayName}'`);
			return m.id;
		}
		async function liveRoleId(forResource: 'file' | 'folder' | 'space'): Promise<string> {
			const conditionMatch =
				forResource === 'file' ? '@Resource.File'
					: forResource === 'folder' ? '@Resource.Folder'
						: '@Resource.Root';
			const roles = await liveGet<Array<{ id?: string; rolePermissions?: Array<{ condition?: string }> }>>(
				'/graph/v1beta1/roleManagement/permissions/roleDefinitions',
			);
			const m = (roles ?? []).find((r) =>
				(r.rolePermissions ?? []).some((p) => (p.condition ?? '').includes(conditionMatch)),
			);
			if (!m?.id) throw new Error(`No role found for resource ${forResource}`);
			return m.id;
		}

		it('invites a user to a file with a file-applicable role', async () => {
			const fileName = `invite-file-${Date.now()}.txt`;
			const filePath = tmpPath(fileName);

			let recipientId = 'user-uuid-1';
			let roleId = 'role-uuid-viewer';

			if (IS_INTEGRATION) {
				await ensureFolder(driveId, TMP_ROOT);
				await runOnceJson({
					resource: 'file', operation: 'upload', space: driveId,
					path: TMP_ROOT, name: fileName,
					binaryDataUpload: false, fileContent: 'invite me',
				});
				recipientId = await liveUserId('Alan Turing');
				roleId = await liveRoleId('file');
			} else {
				const itemId = `${driveId}!report`;
				nockChildrenWalk(
					[{ id: `${driveId}!tmp`, name: TMP_ROOT.slice(1), folder: {} }],
					[{ id: itemId, name: fileName, file: { mimeType: 'text/plain' } }],
				);
				nock(TEST_SERVER)
					.post(
						`/graph/v1beta1/drives/${driveIdEnc}/items/${encodeURIComponent(itemId)}/invite`,
						{
							recipients: [{ objectId: recipientId, '@libre.graph.recipient.type': 'user' }],
							roles: [roleId],
						},
					)
					.reply(200, {
						value: [{
							id: 'perm-1',
							roles: [roleId],
							grantedToV2: { user: { id: recipientId } },
						}],
					});
			}

			// recipientId is wrapped in the resourceLocator shape the n8n editor
			// produces, to verify the handler's getNodeParameter(..., {extractValue:
			// true}) path unwraps it correctly. The group invite test below leaves
			// it as a bare string to keep back-compat coverage.
			const result = (await runOnceJson({
				resource: 'file', operation: 'share', space: driveId,
				path: filePath,
				recipientType: 'user',
				recipientId: { __rl: true, mode: 'list', value: recipientId },
				role: roleId,
				expirationDateTime: '',
			})) as { id?: string; roles?: string[]; grantedToV2?: { user?: { id?: string } } };

			expect(result.id).toBeTruthy();
			expect(result.roles).toContain(roleId);
			expect(result.grantedToV2?.user?.id).toBe(recipientId);

			if (IS_INTEGRATION) {
				await runOnceJson({
					resource: 'file', operation: 'delete', space: driveId, path: filePath,
				}).catch(() => null);
			}
		});

		it('invites a group to a folder with a folder-applicable role + expiration', async () => {
			const folderName = `invite-folder-${Date.now()}`;
			const folderPath = tmpPath(folderName);

			let recipientId = 'group-uuid-1';
			let roleId = 'role-uuid-editor';
			const exp = '2030-01-01T00:00:00Z';

			if (IS_INTEGRATION) {
				await ensureFolder(driveId, TMP_ROOT);
				await runOnceJson({
					resource: 'folder', operation: 'create',
					space: driveId, path: TMP_ROOT, name: folderName,
				});
				recipientId = await liveGroupId('chess-lovers');
				roleId = await liveRoleId('folder');
			} else {
				const itemId = `${driveId}!reports-folder`;
				nockChildrenWalk(
					[{ id: `${driveId}!tmp`, name: TMP_ROOT.slice(1), folder: {} }],
					[{ id: itemId, name: folderName, folder: {} }],
				);
				nock(TEST_SERVER)
					.post(
						`/graph/v1beta1/drives/${driveIdEnc}/items/${encodeURIComponent(itemId)}/invite`,
						{
							recipients: [{ objectId: recipientId, '@libre.graph.recipient.type': 'group' }],
							roles: [roleId],
							expirationDateTime: exp,
						},
					)
					.reply(200, {
						value: [{ id: 'perm-2', roles: [roleId], grantedToV2: { group: { id: recipientId } } }],
					});
			}

			const result = (await runOnceJson({
				resource: 'folder', operation: 'share', space: driveId,
				path: folderPath,
				recipientType: 'group',
				recipientId,
				role: roleId,
				expirationDateTime: exp,
			})) as { id?: string; roles?: string[]; grantedToV2?: { group?: { id?: string } } };

			expect(result.id).toBeTruthy();
			expect(result.roles).toContain(roleId);
			expect(result.grantedToV2?.group?.id).toBe(recipientId);

			if (IS_INTEGRATION) {
				await runOnceJson({
					resource: 'folder', operation: 'delete', space: driveId, path: folderPath,
				}).catch(() => null);
			}
		});

		it('invites a user to a space (drive root) with a space-applicable role', async () => {
			let targetSpaceId = driveId;
			let targetSpaceIdEnc = driveIdEnc;
			let recipientId = 'user-uuid-space';
			let roleId = 'role-uuid-manager';

			if (IS_INTEGRATION) {
				// Personal drives can't accept root invites ("unsupported space
				// type"). Spin up a tmp project space for the test, invite into
				// that, then delete it. Project spaces accept root invites.
				const httpCall = makeExecuteFunctions({ parameters: {} }).fns.helpers
					.httpRequestWithAuthentication as (
					cred: string,
					opts: { method: string; url: string; body?: unknown; headers?: Record<string, string>; json: boolean },
				) => Promise<{ id?: string }>;
				const created = await httpCall('openCloudApi', {
					method: 'POST',
					url: `${TEST_SERVER}/graph/v1.0/drives`,
					body: {
						name: `n8n-test-space-${Date.now()}`,
						driveType: 'project',
						description: 'tmp space for invite test',
					},
					headers: { 'Content-Type': 'application/json' },
					json: true,
				});
				if (!created.id) throw new Error('project-space creation returned no id');
				targetSpaceId = created.id;
				targetSpaceIdEnc = encodeURIComponent(created.id);
				recipientId = await liveUserId('Alan Turing');
				roleId = await liveRoleId('space');
			} else {
				nock(TEST_SERVER)
					.post(`/graph/v1beta1/drives/${targetSpaceIdEnc}/root/invite`, {
						recipients: [{ objectId: recipientId, '@libre.graph.recipient.type': 'user' }],
						roles: [roleId],
					})
					.reply(200, {
						value: [{ id: 'perm-root', roles: [roleId], grantedToV2: { user: { id: recipientId } } }],
					});
			}

			try {
				const result = (await runOnceJson({
					resource: 'space', operation: 'share', space: targetSpaceId,
					recipientType: 'user',
					recipientId,
					role: roleId,
					expirationDateTime: '',
				})) as { id?: string; roles?: string[]; grantedToV2?: { user?: { id?: string } } };

				expect(result.id).toBeTruthy();
				expect(result.roles).toContain(roleId);
				if (IS_INTEGRATION) {
					expect(result.grantedToV2?.user?.id).toBe(recipientId);
				}
			} finally {
				if (IS_INTEGRATION && targetSpaceId !== driveId) {
					// Two-step delete to actually purge (single DELETE only moves
					// to trash). DELETE → trashes; DELETE + `Purge: T` → removes.
					// Both best-effort so a stack with stale trash doesn't trip CI.
					const httpCall = makeExecuteFunctions({ parameters: {} }).fns.helpers
						.httpRequestWithAuthentication as (
						cred: string,
						opts: { method: string; url: string; headers?: Record<string, string>; json: boolean },
					) => Promise<unknown>;
					const url = `${TEST_SERVER}/graph/v1.0/drives/${targetSpaceIdEnc}`;
					await httpCall('openCloudApi', { method: 'DELETE', url, json: true })
						.catch(() => null);
					await httpCall('openCloudApi', {
						method: 'DELETE', url, headers: { Purge: 'T' }, json: true,
					}).catch(() => null);
				}
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
					.reply(204)
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

			// Update
			const updated = (await runOnceJson({
				resource: 'user',
				operation: 'update',
				userId: created.id,
				updateFields: { displayName: 'Renamed' },
			})) as { success?: boolean };
			expect(updated.success).toBe(true);

			// Delete
			const deleted = (await runOnceJson({
				resource: 'user',
				operation: 'delete',
				userId: created.id,
			})) as { success?: boolean };
			expect(deleted.success).toBe(true);
		});
	});

	// --- loadOptions: dropdowns populated from Graph endpoints ---

	describe('loadOptions: getLinkTypes', () => {
		// Pure catalog filter, no network. The spec-defined enum is hardcoded
		// (no Graph endpoint serves it); what's dynamic is per-resource filtering.
		it('exposes file-only link types when resource is file', async () => {
			const { fns } = makeLoadOptionsFunctions({ currentParameters: { resource: 'file' } });
			const options = await node.methods.loadOptions.getLinkTypes.call(fns);
			const values = options.map((o) => o.value);
			expect(values).toContain('view');
			expect(values).toContain('edit');
			expect(values).not.toContain('upload');
			expect(values).not.toContain('createOnly');
		});

		it('exposes folder-applicable link types when resource is folder', async () => {
			const { fns } = makeLoadOptionsFunctions({ currentParameters: { resource: 'folder' } });
			const options = await node.methods.loadOptions.getLinkTypes.call(fns);
			const values = options.map((o) => o.value);
			expect(values).toEqual(expect.arrayContaining(['view', 'edit', 'upload', 'createOnly']));
		});

		it('falls back to the full catalog when resource is not set', async () => {
			const { fns } = makeLoadOptionsFunctions({ currentParameters: {} });
			const options = await node.methods.loadOptions.getLinkTypes.call(fns);
			expect(options.map((o) => o.value)).toEqual(
				expect.arrayContaining(['view', 'edit', 'upload', 'createOnly', 'blocksDownload', 'internal']),
			);
		});

		it('exposes internal link type across all resource kinds', async () => {
			for (const resource of ['file', 'folder', 'space'] as const) {
				const { fns } = makeLoadOptionsFunctions({ currentParameters: { resource } });
				const options = await node.methods.loadOptions.getLinkTypes.call(fns);
				expect(options.map((o) => o.value)).toContain('internal');
			}
		});
	});

	describe('loadOptions: getShareRoles', () => {
		const fileRole = {
			id: 'role-file',
			displayName: 'File Viewer',
			rolePermissions: [{ condition: 'exists @Resource.File' }],
		};
		const folderRole = {
			id: 'role-folder',
			displayName: 'Folder Editor',
			rolePermissions: [{ condition: 'exists @Resource.Folder' }],
		};
		const rootRole = {
			id: 'role-root',
			displayName: 'Space Manager',
			rolePermissions: [{ condition: 'exists @Resource.Root' }],
		};

		const mockRoleList = () =>
			nock(TEST_SERVER)
				.get('/graph/v1beta1/roleManagement/permissions/roleDefinitions')
				.reply(200, [fileRole, folderRole, rootRole]);

		// Dual-mode: in integration mode this hits the real server, catching
		// any drift between the spec we coded against and what the deployment
		// actually serves (path version, response wrapping, etc.).
		it('returns file-applicable roles when resource is file', async () => {
			if (!IS_INTEGRATION) mockRoleList();
			const { fns } = makeLoadOptionsFunctions({ currentParameters: { resource: 'file' } });
			const options = await node.methods.loadOptions.getShareRoles.call(fns);
			expect(options.length).toBeGreaterThan(0);
			if (!IS_INTEGRATION) {
				expect(options.map((o) => o.value)).toEqual(['role-file']);
				expect(options[0].name).toBe('File Viewer');
			}
			// In either mode, every returned role's condition should reference
			// @Resource.File (the predicate we filter on). Assertion is shape-based
			// so it survives whatever specific roles the real server ships.
			for (const opt of options) {
				expect(typeof opt.value).toBe('string');
				expect((opt.value as string).length).toBeGreaterThan(0);
			}
		});

		it('returns folder-applicable roles when resource is folder', async () => {
			if (!IS_INTEGRATION) mockRoleList();
			const { fns } = makeLoadOptionsFunctions({ currentParameters: { resource: 'folder' } });
			const options = await node.methods.loadOptions.getShareRoles.call(fns);
			expect(options.length).toBeGreaterThan(0);
			if (!IS_INTEGRATION) {
				expect(options.map((o) => o.value)).toEqual(['role-folder']);
			}
		});

		it('returns drive-root roles when resource is space', async () => {
			if (!IS_INTEGRATION) mockRoleList();
			const { fns } = makeLoadOptionsFunctions({ currentParameters: { resource: 'space' } });
			const options = await node.methods.loadOptions.getShareRoles.call(fns);
			expect(options.length).toBeGreaterThan(0);
			if (!IS_INTEGRATION) {
				expect(options.map((o) => o.value)).toEqual(['role-root']);
			}
		});

		it('falls back to all roles when resource cannot be read', async () => {
			if (!IS_INTEGRATION) mockRoleList();
			const { fns } = makeLoadOptionsFunctions({ currentParameters: {} });
			const options = await node.methods.loadOptions.getShareRoles.call(fns);
			expect(options.length).toBeGreaterThan(0);
			if (!IS_INTEGRATION) {
				expect(options.map((o) => o.value).sort()).toEqual(['role-file', 'role-folder', 'role-root']);
			}
		});
	});

	describe('listSearch: searchRecipients', () => {
		it('lists users when recipientType is user', async () => {
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.get('/graph/v1.0/users')
					.query({ $top: '100' })
					.reply(200, {
						value: [
							{ id: 'u-1', displayName: 'Alice', onPremisesSamAccountName: 'alice', mail: 'alice@example.com' },
							{ id: 'u-2', displayName: 'Bob' },
						],
					});
			}
			const { fns } = makeLoadOptionsFunctions({
				currentParameters: { recipientType: 'user' },
			});
			const result = await node.methods.listSearch.searchRecipients.call(fns);
			expect(result.results.length).toBeGreaterThan(0);
			if (!IS_INTEGRATION) {
				expect(result.results.map((o) => o.value)).toEqual(['u-1', 'u-2']);
				expect(result.results[0].name).toBe('Alice (alice@example.com)');
			} else {
				// Every returned entry should at least carry an id-shaped value.
				for (const entry of result.results) {
					expect(typeof entry.value).toBe('string');
					expect((entry.value as string).length).toBeGreaterThan(0);
				}
			}
		});

		it('lists groups when recipientType is group', async () => {
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.get('/graph/v1.0/groups')
					.query({ $top: '100' })
					.reply(200, { value: [{ id: 'g-1', displayName: 'Engineering' }] });
			}
			const { fns } = makeLoadOptionsFunctions({
				currentParameters: { recipientType: 'group' },
			});
			const result = await node.methods.listSearch.searchRecipients.call(fns);
			if (!IS_INTEGRATION) {
				expect(result.results.map((o) => o.value)).toEqual(['g-1']);
				expect(result.results[0].name).toBe('Engineering');
			} else {
				// Real server may or may not have groups; just verify the call shape.
				for (const entry of result.results) {
					expect(typeof entry.value).toBe('string');
				}
			}
		});

		it('defaults to users when recipientType is not set', async () => {
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.get('/graph/v1.0/users')
					.query({ $top: '100' })
					.reply(200, { value: [{ id: 'u-x', displayName: 'X' }] });
			}
			const { fns } = makeLoadOptionsFunctions({ currentParameters: {} });
			const result = await node.methods.listSearch.searchRecipients.call(fns);
			expect(result.results.length).toBeGreaterThan(0);
			if (!IS_INTEGRATION) {
				expect(result.results.map((o) => o.value)).toEqual(['u-x']);
			}
		});

		it('narrows results when a filter string is provided', async () => {
			if (!IS_INTEGRATION) {
				nock(TEST_SERVER)
					.get('/graph/v1.0/users')
					.query({ $top: '100', $search: '"Alan"' })
					.reply(200, {
						value: [
							{ id: 'u-alan', displayName: 'Alan Turing', mail: 'alan@example.com' },
						],
					});
			}
			const { fns } = makeLoadOptionsFunctions({
				currentParameters: { recipientType: 'user' },
			});
			const result = await node.methods.listSearch.searchRecipients.call(fns, 'Alan');
			expect(result.results.length).toBeGreaterThan(0);
			// Every returned entry should match the filter (case-insensitive).
			// In integration mode we hit the live server's $search, which matches
			// across displayName / mail / onPremisesSamAccountName, so the filter
			// substring must appear in at least one of the rendered fields.
			for (const entry of result.results) {
				expect((entry.name as string).toLowerCase()).toContain('alan');
			}
		});

		mockOnly.it('passes filter through as $search and forwards nextLink as paginationToken', async () => {
			nock(TEST_SERVER)
				.get('/graph/v1.0/users')
				.query({ $top: '100', $search: '"ali"' })
				.reply(200, {
					value: [{ id: 'u-1', displayName: 'Alice' }],
					'@odata.nextLink': '/graph/v1.0/users?$top=100&$search=%22ali%22&$skiptoken=abc',
				});
			const { fns } = makeLoadOptionsFunctions({
				currentParameters: { recipientType: 'user' },
			});
			const result = await node.methods.listSearch.searchRecipients.call(fns, 'ali');
			expect(result.results.map((o) => o.value)).toEqual(['u-1']);
			expect(result.paginationToken).toBe(
				'/graph/v1.0/users?$top=100&$search=%22ali%22&$skiptoken=abc',
			);
		});
	});

	describe('space:share', () => {
		it('creates a public link at the drive root', async () => {
			// Personal drives reject root createLink with "unsupported space type",
			// so integration mode spins up a tmp project space (same pattern as the
			// space invite test) and tears it down with disable+purge.
			let targetSpaceId = driveId;
			let targetSpaceIdEnc = driveIdEnc;

			if (IS_INTEGRATION) {
				const { fns: httpFns } = makeExecuteFunctions({ parameters: {} });
				const httpCall = httpFns.helpers.httpRequestWithAuthentication as (
					cred: string,
					opts: { method: string; url: string; body?: unknown; headers?: Record<string, string>; json: boolean },
				) => Promise<{ id?: string }>;
				const created = await httpCall('openCloudApi', {
					method: 'POST',
					url: `${TEST_SERVER}/graph/v1.0/drives`,
					body: {
						name: `n8n-link-space-${Date.now()}`,
						driveType: 'project',
						description: 'tmp space for public-link test',
					},
					headers: { 'Content-Type': 'application/json' },
					json: true,
				});
				if (!created.id) throw new Error('project-space creation returned no id');
				targetSpaceId = created.id;
				targetSpaceIdEnc = encodeURIComponent(created.id);
			} else {
				nock(TEST_SERVER)
					.post(`/graph/v1beta1/drives/${targetSpaceIdEnc}/root/createLink`, { type: 'view' })
					.reply(200, {
						id: 'perm-root-link',
						link: { type: 'view', webUrl: `${TEST_SERVER}/s/root-link` },
					});
			}

			const { fns } = makeExecuteFunctions({
				parameters: {
					resource: 'space', operation: 'share', space: targetSpaceId,
					recipientType: 'publicLink',
					linkType: 'view', password: '', expirationDateTime: '',
				},
			});
			let result: Array<Array<{ json: { link?: { type?: string } } }>>;
			try {
				result = (await node.execute.call(fns)) as Array<Array<{ json: { link?: { type?: string } } }>>;
			} catch (err) {
				// If a non-default OpenCloud install enforces a password policy on
				// view links the node throws the "set password" hint. Our CI
				// compose disables enforcement (OC_SHARING_PUBLIC_*_MUST_HAVE_PASSWORD=false),
				// so this branch is effectively dead on the canonical stack; kept
				// here so the test stays robust against differently-configured
				// servers.
				if (IS_INTEGRATION && /password/i.test((err as Error).message)) {
					// eslint-disable-next-line no-console
					console.warn(
						'space:share createLink soft-skipped: server enforces password policy on public links',
					);
					return;
				}
				throw err;
			} finally {
				if (IS_INTEGRATION && targetSpaceId !== driveId) {
					const { fns: cleanupFns } = makeExecuteFunctions({ parameters: {} });
					const httpCall = cleanupFns.helpers.httpRequestWithAuthentication as (
						cred: string,
						opts: { method: string; url: string; headers?: Record<string, string>; json: boolean },
					) => Promise<unknown>;
					const url = `${TEST_SERVER}/graph/v1.0/drives/${targetSpaceIdEnc}`;
					await httpCall('openCloudApi', { method: 'DELETE', url, json: true })
						.catch(() => null);
					await httpCall('openCloudApi', {
						method: 'DELETE', url, headers: { Purge: 'T' }, json: true,
					}).catch(() => null);
				}
			}
			expect(result[0][0].json.link?.type).toBe('view');
		});

		// Pure validation, no network: dual-mode by definition.
		it('rejects invite missing recipientId with a clear error', async () => {
			const { fns } = makeExecuteFunctions({
				parameters: {
					resource: 'space', operation: 'share', space: driveId,
					recipientType: 'user',
					recipientId: '',
					role: 'role-x',
				},
			});
			await expect(node.execute.call(fns)).rejects.toThrow(/Recipient ID is required/);
		});

		it('rejects invite missing role with a clear error', async () => {
			const { fns } = makeExecuteFunctions({
				parameters: {
					resource: 'space', operation: 'share', space: driveId,
					recipientType: 'user',
					recipientId: 'u-1',
					role: '',
				},
			});
			await expect(node.execute.call(fns)).rejects.toThrow(/Role is required/);
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
					recipientType: 'publicLink',
					path: '/Documents/report.pdf',
					linkType: 'view', password: '', expirationDateTime: '',
				},
			});
			await expect(node.execute.call(fns)).rejects.toThrow(
				/This link type requires a password on the server/,
			);
		});

		mockOnly.it('cross-space folder COPY (mock — depends on a second drive)', async () => {
			const otherDriveEnc = encodeURIComponent('storage-users-2$other-space-id');
			nock(TEST_SERVER)
				.intercept(`/dav/spaces/${driveIdEnc}/Documents/Reports`, 'COPY')
				.matchHeader('Destination', `${TEST_SERVER}/dav/spaces/${otherDriveEnc}/Shared/Reports`)
				.reply(201);
			await runOnceJson({
				resource: 'folder', operation: 'copy', space: driveId,
				path: '/Documents/Reports',
				destSpace: 'storage-users-2$other-space-id',
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
