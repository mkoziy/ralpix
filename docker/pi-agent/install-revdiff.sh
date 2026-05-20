#!/usr/bin/env bash

set -euo pipefail

REVDIFF_VERSION="${REVDIFF_VERSION:?REVDIFF_VERSION is required}"

source "/opt/ralpix/docker/pi-agent/revdiff-common.sh"

release_json="$(revdiff_release_json "${REVDIFF_API_URL}/tags/${REVDIFF_VERSION}")"
revdiff_install_from_release_json "${release_json}" "${REVDIFF_VERSION}"
