#!/usr/bin/env bash
# Patches every OpenCloud node in the smoke-test workflow JSON to reference
# your actual OpenCloudApi credential, so importing into n8n doesn't require
# clicking through 11 nodes to set the credential.
#
# Usage:
#   ./apply-credentials.sh <credential-id> [input-file] > patched.workflow.json
#
# Find your credential id with:
#   n8n export:credentials --all | jq '.[] | select(.type == "openCloudApi") | .id'
#
# (Only `id` matters — n8n resolves credentials by id at execution time and
# refreshes the displayed name from the live credential record on import.)
#
# Defaults: input-file = ./smoke-test.workflow.json (next to this script)

set -euo pipefail

if [[ $# -lt 1 ]]; then
	echo "usage: $0 <credential-id> [input-file]" >&2
	exit 1
fi

CRED_ID="$1"
INPUT="${2:-$(dirname "$0")/smoke-test.workflow.json}"

if [[ ! -f "$INPUT" ]]; then
	echo "input file not found: $INPUT" >&2
	exit 1
fi

jq --arg id "$CRED_ID" '
	.nodes |= map(
		if .type == "@opencloud-eu/n8n-nodes-opencloud.openCloud" then
			.credentials.openCloudApi.id = $id
		else . end
	)
' "$INPUT"
