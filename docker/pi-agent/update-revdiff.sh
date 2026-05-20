#!/usr/bin/env bash

set -euo pipefail

source "/opt/ralpix/docker/pi-agent/revdiff-common.sh"

current_version=""
if [ -f "${REVDIFF_VERSION_FILE}" ]; then
  current_version="$(tr -d '[:space:]' < "${REVDIFF_VERSION_FILE}")"
fi

release_json="$(revdiff_release_json "${REVDIFF_API_URL}/latest")"
latest_version="$(printf '%s' "${release_json}" | revdiff_select_tag_name)"

if [ -n "${current_version}" ] && [ "${current_version}" = "${latest_version}" ]; then
  exit 0
fi

printf 'revdiff: updating from %s to %s\n' "${current_version:-none}" "${latest_version}" >&2
revdiff_install_from_release_json "${release_json}" "${latest_version}"
