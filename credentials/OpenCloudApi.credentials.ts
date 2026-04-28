import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class OpenCloudApi implements ICredentialType {
	name = 'openCloudApi';

	displayName = 'OpenCloud API';

	icon: Icon = 'file:../icons/opencloud.svg';

	documentationUrl = 'https://docs.opencloud.eu/';

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			placeholder: 'https://opencloud.example.com',
			default: '',
			description: 'Base URL of the OpenCloud server',
		},
		{
			displayName: 'User',
			name: 'user',
			type: 'string',
			default: '',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'OpenCloud app token (preferred) or account password. Generate an app token from your OpenCloud profile for automation use.',
		},
		{
			displayName: 'Skip TLS Certificate Verification',
			name: 'skipTlsVerification',
			type: 'boolean',
			default: false,
			description:
				'Whether to accept self-signed or otherwise untrusted TLS certificates. Useful for local dev OpenCloud instances; never enable against production servers.',
		},
	];

	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		requestOptions.auth = {
			username: credentials.user as string,
			password: credentials.password as string,
		};
		if (credentials.skipTlsVerification === true) {
			requestOptions.skipSslCertificateValidation = true;
		}
		return requestOptions;
	}

	test: ICredentialTestRequest = {
		request: {
			// Strip any trailing slashes so users don't have to think about them.
			// Runtime requests already do the same in GenericFunctions.ts.
			baseURL: '={{ $credentials.serverUrl.replace(/\\/+$/, "") }}',
			url: '/graph/v1.0/me/drives',
			skipSslCertificateValidation: '={{$credentials.skipTlsVerification}}',
		},
	};
}
