import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import type { DriveItemsResponse, DrivesResponse } from './GenericFunctions';
import { openCloudApiRequest } from './GenericFunctions';

function driveChildrenUrl(driveId: string, itemId: string): string {
	return `/graph/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/children`;
}

function splitPath(rawPath: string): string[] {
	return rawPath.split('/').filter((segment) => segment.length > 0);
}

function joinPath(segments: string[]): string {
	return segments.length === 0 ? '' : '/' + segments.map(encodeURIComponent).join('/');
}

function spaceWebDavUrl(serverUrl: string, driveId: string, path: string): string {
	const base = serverUrl.replace(/\/+$/, '');
	return `${base}/dav/spaces/${encodeURIComponent(driveId)}${joinPath(splitPath(path))}`;
}

function lastSegment(path: string): string {
	const segments = splitPath(path);
	return segments.length === 0 ? '' : segments[segments.length - 1];
}

async function resolvePathToItemId(
	context: IExecuteFunctions,
	driveId: string,
	rawPath: string,
	itemIndex: number,
): Promise<string> {
	const segments = splitPath(rawPath);
	let currentItemId = driveId;
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		const isLast = i === segments.length - 1;
		const stepResponse = (await openCloudApiRequest.call(
			context,
			'GET',
			driveChildrenUrl(driveId, currentItemId),
			'',
			{},
			true,
		)) as DriveItemsResponse;

		// Intermediate segments must be folders; the final segment can be any item type
		// (file or folder), so file paths like /Documents/file.pdf resolve correctly.
		const match = (stepResponse.value ?? []).find(
			(child) => child.name === segment && (isLast || child.folder),
		);
		if (!match?.id) {
			throw new NodeOperationError(
				context.getNode(),
				`Path not found: ${rawPath}`,
				{ description: `Could not resolve segment "${segment}".`, itemIndex },
			);
		}
		currentItemId = match.id;
	}
	return currentItemId;
}

export class OpenCloud implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'OpenCloud',
		name: 'openCloud',
		icon: 'file:opencloud.svg',
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Access data on OpenCloud',
		defaults: {
			name: 'OpenCloud',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'openCloudApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'File',
						value: 'file',
					},
					{
						name: 'Folder',
						value: 'folder',
					},
					{
						name: 'Space',
						value: 'space',
					},
					{
						name: 'User',
						value: 'user',
					},
				],
				default: 'folder',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['space'],
					},
				},
				options: [
					{
						name: 'List',
						value: 'list',
						description: 'List all drives (Personal, Shares, Project) the authenticated user can see',
						action: 'List spaces',
					},
				],
				default: 'list',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['user'],
					},
				},
				options: [
					{
						name: 'Create',
						value: 'create',
						description: 'Create a user (admin only)',
						action: 'Create a user',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a user (admin only)',
						action: 'Delete a user',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Retrieve a single user by ID',
						action: 'Get a user',
					},
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'List many users',
						action: 'Get many users',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update a user',
						action: 'Update a user',
					},
				],
				default: 'getAll',
			},
			// User: id (used for get / update / delete)
			{
				displayName: 'User ID',
				name: 'userId',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'b1f74ec4-dd7e-11ef-a543-03775734d0f7',
				displayOptions: {
					show: {
						resource: ['user'],
						operation: ['get', 'update', 'delete'],
					},
				},
				description: 'GUID of the user. Use the User → Get Many operation to find IDs.',
			},
			// User: create fields
			{
				displayName: 'Username',
				name: 'userName',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'jdoe',
				displayOptions: {
					show: {
						resource: ['user'],
						operation: ['create'],
					},
				},
				description: 'Login name (onPremisesSamAccountName). Must be unique on the server.',
			},
			{
				displayName: 'Display Name',
				name: 'displayName',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'Jane Doe',
				displayOptions: {
					show: {
						resource: ['user'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'jane@example.com',
				displayOptions: {
					show: {
						resource: ['user'],
						operation: ['create'],
					},
				},
			},
			{
				displayName: 'Password',
				name: 'password',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['user'],
						operation: ['create'],
					},
				},
				description: 'Initial password. Must satisfy the server\'s password policy.',
			},
			// User: update fields
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add field',
				default: {},
				displayOptions: {
					show: {
						resource: ['user'],
						operation: ['update'],
					},
				},
				options: [
					{ displayName: 'Display Name', name: 'displayName', type: 'string', default: '' },
					{ displayName: 'Email', name: 'mail', type: 'string', default: '' },
					{
						displayName: 'Password',
						name: 'password',
						type: 'string',
						typeOptions: { password: true },
						default: '',
						description: 'New password. Must satisfy the server policy.',
					},
					{
						displayName: 'Account Enabled',
						name: 'accountEnabled',
						type: 'boolean',
						default: true,
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['folder'],
					},
				},
				options: [
					{
						name: 'Copy',
						value: 'copy',
						description: 'Copy a folder',
						action: 'Copy a folder',
					},
					{
						name: 'Create',
						value: 'create',
						description: 'Create a new folder',
						action: 'Create a folder',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a folder',
						action: 'Delete a folder',
					},
					{
						name: 'List',
						value: 'list',
						description: 'List the contents of a folder',
						action: 'List a folder',
					},
					{
						name: 'Move',
						value: 'move',
						description: 'Move (or rename) a folder',
						action: 'Move a folder',
					},
					{
						name: 'Share',
						value: 'share',
						description: 'Create a public sharing link for a folder',
						action: 'Share a folder',
					},
				],
				default: 'list',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['file'],
					},
				},
				options: [
					{
						name: 'Copy',
						value: 'copy',
						description: 'Copy a file',
						action: 'Copy a file',
					},
					{
						name: 'Delete',
						value: 'delete',
						description: 'Delete a file',
						action: 'Delete a file',
					},
					{
						name: 'Download',
						value: 'download',
						description: 'Download a file',
						action: 'Download a file',
					},
					{
						name: 'Move',
						value: 'move',
						description: 'Move (or rename) a file',
						action: 'Move a file',
					},
					{
						name: 'Share',
						value: 'share',
						description: 'Create a public sharing link for a file',
						action: 'Share a file',
					},
					{
						name: 'Upload',
						value: 'upload',
						description: 'Upload a file',
						action: 'Upload a file',
					},
				],
				default: 'upload',
			},
			{
				displayName: 'Space Name or ID',
				name: 'space',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getSpaces',
				},
				default: '',
				required: true,
				description:
					'The OpenCloud space (drive) to operate in. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						resource: ['folder', 'file'],
					},
				},
			},
			{
				displayName: 'Path',
				name: 'path',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['list', 'create', 'delete', 'copy', 'move', 'share'],
					},
				},
				placeholder: '/Documents',
				description:
					'Folder path within the selected space. For Create, this is the parent folder. For Copy/Move, this is the source folder. Leave empty for the space root.',
			},
			{
				displayName: 'Path',
				name: 'path',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['file'],
						operation: ['delete', 'download', 'copy', 'move', 'share'],
					},
				},
				placeholder: '/Documents/report.pdf',
				description: 'Full path of the file within the selected space',
			},
			{
				displayName: 'Destination Space Name or ID',
				name: 'destSpace',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getSpaces',
				},
				default: '',
				description: 'Target space (drive) for the copy or move. Leave empty to use the source space. For Move, must be the same storage as source — cross-storage moves are rejected by the server. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						resource: ['file', 'folder'],
						operation: ['copy', 'move'],
					},
				},
			},
			{
				displayName: 'Destination Parent Path',
				name: 'destParentPath',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['file', 'folder'],
						operation: ['copy', 'move'],
					},
				},
				placeholder: '/Archive',
				description: 'Folder under which to place the copied/moved item. Leave empty for the space root.',
			},
			{
				displayName: 'New Name',
				name: 'destName',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['file', 'folder'],
						operation: ['copy', 'move'],
					},
				},
				placeholder: '(keep source name)',
				description: 'Optional new name for the copied/moved item. Leave empty to keep the source name.',
			},
			{
				displayName: 'Parent Path',
				name: 'path',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['file'],
						operation: ['upload'],
					},
				},
				placeholder: '/Documents',
				description: 'Folder to upload the file into. Leave empty for the space root.',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['file'],
						operation: ['upload'],
					},
				},
				placeholder: 'report.pdf',
				description: 'Filename to create in the parent folder',
			},
			{
				displayName: 'Binary File',
				name: 'binaryDataUpload',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						resource: ['file'],
						operation: ['upload'],
					},
				},
				description: 'Whether to read the file bytes from a binary property on the input item. Turn off to upload literal text content from the field below.',
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryProperty',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						resource: ['file'],
						operation: ['upload'],
						binaryDataUpload: [true],
					},
				},
				description: 'Name of the binary property on the input item that contains the file bytes',
			},
			{
				displayName: 'File Content',
				name: 'fileContent',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				displayOptions: {
					show: {
						resource: ['file'],
						operation: ['upload'],
						binaryDataUpload: [false],
					},
				},
				placeholder: 'Hello, OpenCloud!',
				description: 'Literal text content to upload as the file. Sent with Content-Type text/plain.',
			},
			{
				displayName: 'Put Output File in Field',
				name: 'binaryProperty',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: {
					show: {
						resource: ['file'],
						operation: ['download'],
					},
				},
				description: 'Name of the binary property on the output item to store the downloaded bytes in',
			},
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				default: '',
				required: true,
				displayOptions: {
					show: {
						resource: ['folder'],
						operation: ['create'],
					},
				},
				placeholder: 'Reports/2024',
				description: 'Name of the folder to create. Use forward slashes to create nested folders in one step (e.g. "Reports/2024" creates Reports and, inside it, 2024). Each missing level is created automatically.',
			},
			{
				displayName: 'Link Type',
				name: 'linkType',
				type: 'options',
				default: 'view',
				displayOptions: {
					show: {
						resource: ['file', 'folder'],
						operation: ['share'],
					},
				},
				options: [
					{ name: 'Blocks Download', value: 'blocksDownload', description: 'View-only without download capability' },
					{ name: 'Create Only', value: 'createOnly', description: 'Folder only — recipients can add but not list' },
					{ name: 'Edit', value: 'edit', description: 'Recipients can view and edit the item' },
					{ name: 'Upload', value: 'upload', description: 'Folder only — recipients can add new items' },
					{ name: 'View', value: 'view', description: 'Recipients can view the item' },
				],
				description: 'Permission level granted by the link',
			},
			{
				displayName: 'Password',
				name: 'password',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				displayOptions: {
					show: {
						resource: ['file', 'folder'],
						operation: ['share'],
					},
				},
				description:
					'Optional password protecting the link. The server may require a password for certain link types — if so, the request will fail with a clear hint to set this field.',
			},
			{
				displayName: 'Expiration',
				name: 'expirationDateTime',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['file', 'folder'],
						operation: ['share'],
					},
				},
				placeholder: '2026-12-31T23:59:59Z',
				description: 'Optional ISO-8601 timestamp when the link should expire. Leave empty for no expiration.',
			},
		],
	};

	methods = {
		loadOptions: {
			async getSpaces(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = (await openCloudApiRequest.call(
					this,
					'GET',
					'/graph/v1.0/me/drives',
					'',
					{},
					true,
				)) as DrivesResponse;

				return (response.value ?? []).map((drive) => ({
					name: `${drive.name} (${drive.driveType ?? 'drive'})`,
					value: drive.id ?? '',
				}));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const resource = this.getNodeParameter('resource', 0);
		const operation = this.getNodeParameter('operation', 0);

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'space' && operation === 'list') {
					const response = (await openCloudApiRequest.call(
						this,
						'GET',
						'/graph/v1.0/me/drives',
						'',
						{},
						true,
					)) as DrivesResponse;

					for (const drive of response.value ?? []) {
						returnData.push({
							json: drive as unknown as IDataObject,
							pairedItem: { item: i },
						});
					}
				} else if (resource === 'user' && operation === 'getAll') {
					const response = (await openCloudApiRequest.call(
						this,
						'GET',
						'/graph/v1.0/users',
						'',
						{},
						true,
					)) as { value?: IDataObject[] };

					for (const user of response.value ?? []) {
						returnData.push({ json: user, pairedItem: { item: i } });
					}
				} else if (resource === 'user' && operation === 'get') {
					const userId = this.getNodeParameter('userId', i) as string;
					const response = (await openCloudApiRequest.call(
						this,
						'GET',
						`/graph/v1.0/users/${encodeURIComponent(userId)}`,
						'',
						{},
						true,
					)) as IDataObject;
					returnData.push({ json: response, pairedItem: { item: i } });
				} else if (resource === 'user' && operation === 'create') {
					const userName = (this.getNodeParameter('userName', i) as string).trim();
					const displayName = (this.getNodeParameter('displayName', i) as string).trim();
					const email = (this.getNodeParameter('email', i) as string).trim();
					const password = this.getNodeParameter('password', i) as string;

					if (!userName || !displayName || !email || !password) {
						throw new NodeOperationError(
							this.getNode(),
							'Username, Display Name, Email, and Password are all required',
							{ itemIndex: i },
						);
					}

					const body: IDataObject = {
						onPremisesSamAccountName: userName,
						displayName,
						mail: email,
						passwordProfile: { password },
					};
					const response = (await openCloudApiRequest.call(
						this,
						'POST',
						'/graph/v1.0/users',
						body,
						{ 'Content-Type': 'application/json' },
						true,
					)) as IDataObject;
					returnData.push({ json: response, pairedItem: { item: i } });
				} else if (resource === 'user' && operation === 'update') {
					const userId = this.getNodeParameter('userId', i) as string;
					const updates = this.getNodeParameter('updateFields', i, {}) as IDataObject;

					if (Object.keys(updates).length === 0) {
						throw new NodeOperationError(
							this.getNode(),
							'At least one field to update is required',
							{ itemIndex: i },
						);
					}

					// Translate the password convenience field to passwordProfile.
					const body: IDataObject = { ...updates };
					if (typeof body.password === 'string' && body.password.length > 0) {
						body.passwordProfile = { password: body.password };
					}
					delete body.password;

					await openCloudApiRequest.call(
						this,
						'PATCH',
						`/graph/v1.0/users/${encodeURIComponent(userId)}`,
						body,
						{ 'Content-Type': 'application/json' },
						true,
					);
					returnData.push({
						json: { success: true, resource: 'user', operation: 'update', userId, fields: updates },
						pairedItem: { item: i },
					});
				} else if (resource === 'user' && operation === 'delete') {
					const userId = this.getNodeParameter('userId', i) as string;
					await openCloudApiRequest.call(
						this,
						'DELETE',
						`/graph/v1.0/users/${encodeURIComponent(userId)}`,
						'',
						{},
						true,
					);
					returnData.push({
						json: { success: true, resource: 'user', operation: 'delete', userId },
						pairedItem: { item: i },
					});
				} else if (resource === 'folder' && operation === 'list') {
					const driveId = this.getNodeParameter('space', i) as string;
					const rawPath = this.getNodeParameter('path', i) as string;
					const targetItemId = await resolvePathToItemId(this, driveId, rawPath, i);

					const response = (await openCloudApiRequest.call(
						this,
						'GET',
						driveChildrenUrl(driveId, targetItemId),
						'',
						{},
						true,
					)) as DriveItemsResponse;

					for (const driveItem of response.value ?? []) {
						returnData.push({
							json: driveItem as unknown as IDataObject,
							pairedItem: { item: i },
						});
					}
				} else if (resource === 'folder' && operation === 'create') {
					const driveId = this.getNodeParameter('space', i) as string;
					const parentPath = this.getNodeParameter('path', i) as string;
					const name = this.getNodeParameter('name', i) as string;

					if (!name.trim()) {
						throw new NodeOperationError(this.getNode(), 'Folder name is required', {
							itemIndex: i,
						});
					}

					const credentials = await this.getCredentials<{ serverUrl: string }>('openCloudApi');
					const nameSegments = splitPath(name);
					const parentSegments = splitPath(parentPath);
					const finalPath = '/' + [...parentSegments, ...nameSegments].join('/');
					const finalName = nameSegments[nameSegments.length - 1];

					for (let j = 0; j < nameSegments.length; j++) {
						const segPath = '/' + [...parentSegments, ...nameSegments.slice(0, j + 1)].join('/');
						const url = spaceWebDavUrl(credentials.serverUrl, driveId, segPath);
						try {
							await openCloudApiRequest.call(
								this,
								'MKCOL' as IHttpRequestMethods,
								url,
								'',
								{},
								false,
							);
						} catch (error) {
							const httpCode = String(
								(error as { httpCode?: unknown }).httpCode ??
								(error as { statusCode?: unknown }).statusCode ??
								'',
							);
							if (httpCode === '405') continue;
							throw error;
						}
					}

					returnData.push({
						json: {
							success: true,
							resource: 'folder',
							operation: 'create',
							spaceId: driveId,
							path: finalPath,
							name: finalName,
						},
						pairedItem: { item: i },
					});
				} else if (resource === 'file' && operation === 'upload') {
					const driveId = this.getNodeParameter('space', i) as string;
					const parentPath = this.getNodeParameter('path', i) as string;
					const name = this.getNodeParameter('name', i) as string;
					const isBinary = this.getNodeParameter('binaryDataUpload', i, true) as boolean;

					if (!name.trim()) {
						throw new NodeOperationError(this.getNode(), 'File name is required', {
							itemIndex: i,
						});
					}

					let body: Buffer | string;
					let contentType: string;
					if (isBinary) {
						const binaryProperty = this.getNodeParameter('binaryProperty', i) as string;
						this.helpers.assertBinaryData(i, binaryProperty);
						body = await this.helpers.getBinaryDataBuffer(i, binaryProperty);
						contentType = 'application/octet-stream';
					} else {
						body = this.getNodeParameter('fileContent', i, '') as string;
						contentType = 'text/plain; charset=utf-8';
					}

					const credentials = await this.getCredentials<{ serverUrl: string }>('openCloudApi');
					const filePath = '/' + [...splitPath(parentPath), name].join('/');
					const url = spaceWebDavUrl(credentials.serverUrl, driveId, filePath);

					await openCloudApiRequest.call(
						this,
						'PUT',
						url,
						body,
						{ 'Content-Type': contentType },
						false,
					);

					returnData.push({
						json: {
							success: true,
							resource: 'file',
							operation: 'upload',
							spaceId: driveId,
							path: filePath,
							name,
						},
						pairedItem: { item: i },
					});
				} else if (resource === 'file' && operation === 'download') {
					const driveId = this.getNodeParameter('space', i) as string;
					const rawPath = this.getNodeParameter('path', i) as string;
					const outputProp = this.getNodeParameter('binaryProperty', i);

					if (!rawPath.trim()) {
						throw new NodeOperationError(this.getNode(), 'Path is required for download', {
							itemIndex: i,
						});
					}

					const credentials = await this.getCredentials<{ serverUrl: string }>('openCloudApi');
					const url = spaceWebDavUrl(credentials.serverUrl, driveId, rawPath);

					const data = (await openCloudApiRequest.call(
						this,
						'GET',
						url,
						'',
						{},
						false,
						'arraybuffer',
					)) as Buffer;

					const fileName = lastSegment(rawPath);
					const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as string);
					const newItem: INodeExecutionData = {
						json: {
							success: true,
							resource: 'file',
							operation: 'download',
							spaceId: driveId,
							path: rawPath,
							name: fileName,
						},
						binary: {
							[outputProp]: await this.helpers.prepareBinaryData(buffer, fileName),
						},
						pairedItem: { item: i },
					};
					returnData.push(newItem);
				} else if (
					(operation === 'copy' || operation === 'move') &&
					(resource === 'folder' || resource === 'file')
				) {
					const driveId = this.getNodeParameter('space', i) as string;
					const srcPath = this.getNodeParameter('path', i) as string;
					const destDriveIdRaw = this.getNodeParameter('destSpace', i, '') as string;
					const destDriveId = destDriveIdRaw || driveId;
					const destParentPath = this.getNodeParameter('destParentPath', i) as string;
					const destNameRaw = (this.getNodeParameter('destName', i, '') as string).trim();

					if (!srcPath.trim()) {
						throw new NodeOperationError(this.getNode(), 'Source path is required', {
							itemIndex: i,
						});
					}

					const destName = destNameRaw || lastSegment(srcPath);
					if (!destName) {
						throw new NodeOperationError(
							this.getNode(),
							'Destination name could not be derived from source — set "New Name"',
							{ itemIndex: i },
						);
					}

					const credentials = await this.getCredentials<{ serverUrl: string }>('openCloudApi');
					const srcUrl = spaceWebDavUrl(credentials.serverUrl, driveId, srcPath);
					const destFullPath = '/' + [...splitPath(destParentPath), destName].join('/');
					const destUrl = spaceWebDavUrl(credentials.serverUrl, destDriveId, destFullPath);

					const httpMethod = (operation === 'copy' ? 'COPY' : 'MOVE') as IHttpRequestMethods;

					try {
						await openCloudApiRequest.call(
							this,
							httpMethod,
							srcUrl,
							'',
							{ Destination: destUrl },
							false,
						);
					} catch (error) {
						const httpCode = String(
							(error as { httpCode?: unknown }).httpCode ??
							(error as { statusCode?: unknown }).statusCode ??
							'',
						);
						if (operation === 'move' && httpCode === '502') {
							throw new NodeApiError(this.getNode(), error as JsonObject, {
								message: 'Cross-storage move not supported',
								description:
									'OpenCloud cannot move items between different storage providers. Use Copy followed by Delete instead.',
								itemIndex: i,
							});
						}
						throw error;
					}

					returnData.push({
						json: {
							success: true,
							resource,
							operation,
							sourceSpaceId: driveId,
							sourcePath: srcPath,
							destinationSpaceId: destDriveId,
							destinationPath: destFullPath,
							name: destName,
						},
						pairedItem: { item: i },
					});
				} else if (operation === 'share' && (resource === 'folder' || resource === 'file')) {
					const driveId = this.getNodeParameter('space', i) as string;
					const rawPath = this.getNodeParameter('path', i) as string;
					const linkType = this.getNodeParameter('linkType', i) as string;
					const password = (this.getNodeParameter('password', i, '') as string).trim();
					const expirationDateTime = (
						this.getNodeParameter('expirationDateTime', i, '') as string
					).trim();

					if (!rawPath.trim()) {
						throw new NodeOperationError(this.getNode(), 'Path is required for share', {
							itemIndex: i,
						});
					}

					const itemId = await resolvePathToItemId(this, driveId, rawPath, i);

					const body: IDataObject = { type: linkType };
					if (password) body.password = password;
					if (expirationDateTime) body.expirationDateTime = expirationDateTime;

					try {
						const response = (await openCloudApiRequest.call(
							this,
							'POST',
							`/graph/v1beta1/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/createLink`,
							body,
							{ 'Content-Type': 'application/json' },
							true,
						)) as IDataObject;

						returnData.push({
							json: response,
							pairedItem: { item: i },
						});
					} catch (error) {
						// The server returns 400 "password protection is enforced" when it
						// requires a password for the chosen link type but none was sent. The
						// detail message lives in the response body, which n8n's request stack
						// often drops before our catch — so we can't reliably string-match.
						// Use the HTTP status as the signal: with our pre-validated inputs
						// (linkType from a closed dropdown, item already resolved), the only
						// realistic 400 for a non-internal link with no password is password
						// enforcement.
						//
						// NodeOperationError (not NodeApiError) on purpose: NodeApiError's
						// constructor rewrites the surface message via httpCode → COMMON_ERRORS
						// ("400" → "Bad request - please check your parameters"), clobbering
						// our hint. NodeOperationError passes undefined as the code, so the
						// custom message survives.
						const code = String(
							(error as { httpCode?: unknown }).httpCode ??
								(error as { statusCode?: unknown }).statusCode ??
								(error as { cause?: { statusCode?: unknown } }).cause?.statusCode ??
								'',
						);
						if (code === '400' && !password && linkType !== 'internal') {
							throw new NodeOperationError(
								this.getNode(),
								'This link type requires a password on the server',
								{
									description:
										'Set the Password field and retry. The server enforces a password for this link type.',
									itemIndex: i,
								},
							);
						}
						throw error;
					}
				} else if (operation === 'delete' && (resource === 'folder' || resource === 'file')) {
					const driveId = this.getNodeParameter('space', i) as string;
					const rawPath = this.getNodeParameter('path', i) as string;

					if (!rawPath.trim()) {
						throw new NodeOperationError(this.getNode(), 'Path is required for delete', {
							itemIndex: i,
						});
					}

					// Graph DELETE is unusable here: /v1.0 has no DELETE route on
					// /drives/{id}/items/{id}, and /v1beta1 registers the route but
					// the handler rejects anything that isn't a share-jail drive.
					// Use WebDAV DELETE — same family as create/upload/copy/move.
					const credentials = await this.getCredentials<{ serverUrl: string }>('openCloudApi');
					const url = spaceWebDavUrl(credentials.serverUrl, driveId, rawPath);

					await openCloudApiRequest.call(this, 'DELETE', url, '', {}, false);

					returnData.push({
						json: {
							success: true,
							resource,
							operation: 'delete',
							spaceId: driveId,
							path: rawPath,
						},
						pairedItem: { item: i },
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					// Surface .description too — n8n walks the error response body and
					// stashes the actionable server detail there (e.g. "at least 8
					// characters are required"), while .message is the generic
					// HTTP-status mapping ("Bad request - please check your parameters").
					const e = error as { message?: string; description?: string };
					returnData.push({
						json: {
							error: e.message,
							...(e.description ? { errorDescription: e.description } : {}),
						},
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
