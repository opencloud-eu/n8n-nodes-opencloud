import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
} from 'n8n-workflow';

// Minimal shapes for the Libre Graph responses we read. Extend these
// interfaces when a new operation needs more fields.

export interface Drive {
	id?: string;
	name?: string;
	driveType?: string;
}

export interface DriveItem {
	id?: string;
	name?: string;
	folder?: object;
	file?: { mimeType?: string };
	parentReference?: { driveId?: string; id?: string; name?: string; path?: string };
}

export interface OpenCloudCollection<T> {
	value?: T[];
	'@odata.nextLink'?: string;
}

export type DrivesResponse = OpenCloudCollection<Drive>;
export type DriveItemsResponse = OpenCloudCollection<DriveItem>;

/**
 * Wrapper around `httpRequestWithAuthentication` that resolves the OpenCloud
 * server URL from credentials when called with a path, or accepts an absolute
 * URL for WebDAV calls (which target /dav/spaces/... directly).
 *
 * Pass `encoding: 'arraybuffer'` for binary downloads — the helper returns a
 * Buffer in that case. Otherwise responses are JSON-parsed when `json: true`.
 */
export async function openCloudApiRequest<T = unknown>(
	this: IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	urlOrPath: string,
	body: IDataObject | string | Buffer = '',
	headers: IDataObject = {},
	json: boolean = false,
	encoding?: 'arraybuffer',
): Promise<T> {
	let url = urlOrPath;
	if (!/^https?:\/\//i.test(urlOrPath)) {
		const credentials = await this.getCredentials<{ serverUrl: string }>('openCloudApi');
		const base = credentials.serverUrl.replace(/\/+$/, '');
		url = `${base}${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`;
	}

	const options: IHttpRequestOptions = {
		method,
		url,
		body: body as IHttpRequestOptions['body'],
		headers,
		json,
	};
	if (encoding === 'arraybuffer') {
		options.encoding = 'arraybuffer';
	}

	return (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'openCloudApi',
		options,
	)) as T;
}
