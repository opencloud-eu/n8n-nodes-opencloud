import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { openCloudApiRequest } from '../OpenCloud/GenericFunctions';

// Activity-type catalogue. The activitylog API returns a localized
// `template.message` (in the OpenCloud instance locale, for example German).
// The node requests `Accept-Language: en` and matches the English template
// strings, which are stable across instances. Source of truth for these strings:
// opencloud services/activitylog/pkg/service/response.go (MessageResource*).
const ACTIVITY_TYPES: ReadonlyArray<{ key: string; name: string; message: string }> = [
	{ key: 'fileAdded', name: 'File or folder added', message: '{user} added {resource} to {folder}' },
	{ key: 'fileUpdated', name: 'File or folder updated', message: '{user} updated {resource} in {folder}' },
	{ key: 'fileDeleted', name: 'File or folder deleted', message: '{user} deleted {resource} from {folder}' },
	{ key: 'itemMoved', name: 'Item moved', message: '{user} moved {resource} to {folder}' },
	{ key: 'itemRenamed', name: 'Item renamed', message: '{user} renamed {oldResource} to {resource}' },
	{ key: 'shareCreated', name: 'Share created', message: '{user} shared {resource} with {sharee}' },
	{ key: 'linkCreated', name: 'Link created', message: '{user} shared {resource} via link' },
	{ key: 'spaceShared', name: 'Member added to space', message: '{user} added {sharee} as member of {space}' },
];

const MESSAGE_TO_EVENT = new Map(ACTIVITY_TYPES.map((t) => [t.message, t.key]));

interface Activity {
	id?: string;
	times?: { recordedTime?: string };
	template?: { message?: string; variables?: IDataObject };
}

interface ActivitiesResponse {
	value?: Activity[];
}

export class OpenCloudTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'OpenCloud Trigger',
		name: 'openCloudTrigger',
		icon: 'file:opencloud.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '=On space activity: {{$parameter["spaceId"]["value"]}}',
		description: 'Starts the workflow when activity happens in an OpenCloud space (uploads, edits, shares, ...)',
		defaults: {
			name: 'OpenCloud Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'openCloudApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Space',
				name: 'spaceId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description: 'The space to watch. Pick from the list, or paste its root ID (the drive ID, of the form storageId$spaceId). One trigger watches one space.',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchSpaces',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: '6075b3aa-...$7cb63fc5-...',
					},
				],
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				default: [],
				description: 'Which activity types to emit. Leave empty to emit every activity.',
				options: ACTIVITY_TYPES.map((t) => ({ name: t.name, value: t.key })),
			},
		],
		usableAsTool: true,
	};

	methods = {
		listSearch: {
			// Populate the Space picker from the drives the credential can see.
			async searchSpaces(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const response = (await openCloudApiRequest.call(this, 'GET', '/graph/v1.0/me/drives', '', {}, true)) as {
					value?: Array<{ id?: string; name?: string; driveType?: string }>;
				};
				const term = (filter ?? '').trim().toLowerCase();
				const results = (response.value ?? [])
					.filter((d) => d.id && (term === '' || (d.name ?? '').toLowerCase().includes(term)))
					.map((d) => ({ name: `${d.name ?? d.id} (${d.driveType ?? 'drive'})`, value: d.id as string }));
				return { results };
			},
		},
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const spaceId = (this.getNodeParameter('spaceId', undefined, { extractValue: true }) as string).trim();
		const events = this.getNodeParameter('events', []) as string[];
		const isManual = this.getMode() === 'manual';

		// `kql` carries the filter; the id value MUST be quoted because the literal
		// `$` in {storageId}${spaceId} otherwise breaks the KQL tokenizer.
		const kql = encodeURIComponent(`itemid:"${spaceId}"`);
		const response = (await openCloudApiRequest.call(
			this,
			'GET',
			`/graph/v1beta1/extensions/org.libregraph/activities?kql=${kql}`,
			'',
			{ 'Accept-Language': 'en' },
			true,
		)) as ActivitiesResponse;

		// Need an id for de-duplication: two activities can share a recordedTime.
		const activities = (response.value ?? []).filter(
			(a): a is Activity & { id: string } => typeof a.id === 'string' && a.id.length > 0,
		);

		const decorate = (a: Activity): IDataObject => ({
			event: MESSAGE_TO_EVENT.get(a.template?.message ?? '') ?? 'other',
			recordedTime: a.times?.recordedTime,
			id: a.id,
			message: a.template?.message,
			variables: a.template?.variables,
		});

		const matches = (a: Activity): boolean => {
			if (events.length === 0) return true;
			return events.includes(MESSAGE_TO_EVENT.get(a.template?.message ?? '') ?? 'other');
		};

		// Manual test run: return the matching activities so the user sees data,
		// without advancing the dedup baseline.
		if (isManual) {
			const items = activities.filter(matches).map(decorate);
			return items.length ? [this.helpers.returnJsonArray(items)] : null;
		}

		// De-dup by activity id, not by timestamp: the activitylog can record several
		// activities at the same recordedTime (observed: ms-near uploads), so a
		// `recordedTime > last` window would drop or double events at the boundary.
		//
		// The node remembers exactly the ids currently in the server's activity window.
		// The window is server-bounded and append-only (a purged id never reappears).
		// An id that scrolls out can be forgotten safely, and every id still present
		// (including the ones just emitted) stays remembered and is never re-emitted.
		// This needs no size cap and no assumption about the API's result ordering.
		const staticData = this.getWorkflowStaticData('node');
		const currentIds = activities.map((a) => a.id);

		// First scheduled poll after activation: baseline everything currently present
		// (so activation does not replay history) and emit nothing.
		if (staticData.seenIds === undefined) {
			staticData.seenIds = currentIds;
			return null;
		}

		const seen = new Set(staticData.seenIds as string[]);
		const fresh = activities.filter((a) => !seen.has(a.id));
		const emit = fresh.filter(matches).map(decorate);

		// Remember the whole current window (supersedes the old set).
		staticData.seenIds = currentIds;

		// Diagnostic for the known limitation: the event filter matches the activitylog's
		// English template strings. If a poll sees new activities but every one maps to
		// `other` while an events filter is active, the templates likely drifted upstream
		// (or Accept-Language was not honored). Surface that instead of silently emitting
		// nothing.
		if (events.length > 0 && fresh.length > 0 && emit.length === 0) {
			this.logger?.warn(
				'OpenCloud Trigger: new activities found but none matched the event filter. ' +
					'The activitylog template strings may have changed upstream.',
			);
		}

		return emit.length ? [this.helpers.returnJsonArray(emit)] : null;
	}
}
