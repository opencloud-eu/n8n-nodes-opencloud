import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

// Syscall / network error codes that mean "the request never got an HTTP
// reply" — DNS, refused, timeout, etc. We catch these specifically so the
// user gets a clear "server unreachable" message instead of n8n's generic
// stock string ("The connection cannot be established, this usually
// occurs due to an incorrect host (domain) value").
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
	'ENOTFOUND',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'EAI_AGAIN',
	'ECONNRESET',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EPROTO',
	'CERT_HAS_EXPIRED',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function extractErrorCode(error: unknown): string {
	const e = error as {
		httpCode?: unknown;
		code?: unknown;
		cause?: { code?: unknown; httpCode?: unknown };
	};
	const candidates = [e.httpCode, e.code, e.cause?.code, e.cause?.httpCode];
	for (const c of candidates) {
		if (typeof c === 'string' && c.length > 0) return c;
	}
	return '';
}

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

	try {
		return (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'openCloudApi',
			options,
		)) as T;
	} catch (error) {
		const code = extractErrorCode(error);
		if (NETWORK_ERROR_CODES.has(code)) {
			// Re-throw as NodeOperationError on purpose: NodeApiError's constructor
			// rewrites the surface message via httpCode → COMMON_ERRORS mappings,
			// which would clobber the URL we want users to see. NodeOperationError
			// passes the message through untouched.
			const credentials = await this.getCredentials<{ serverUrl: string }>('openCloudApi');
			throw new NodeOperationError(
				this.getNode(),
				`Cannot reach OpenCloud server at ${credentials.serverUrl} (${code})`,
				{
					description:
						'The request never received a reply from the server. ' +
						'Verify the credential\'s "Server URL" is correct, that the OpenCloud server is running, ' +
						'and that n8n can reach it from inside its container (e.g. host.docker.internal for a host-running server).',
				},
			);
		}
		throw error;
	}
}
