#!/usr/bin/env bash
set -euo pipefail

tool_name="${TOOL_NAME:?TOOL_NAME is required}"
default_host_bin="${DEFAULT_HOST_BIN:?DEFAULT_HOST_BIN is required}"

tool_upper="$(printf '%s' "${tool_name}" | tr '[:lower:]-' '[:upper:]_')"
mode_var="RALPIX_HOST_${tool_upper}_MODE"
bin_var="RALPIX_HOST_${tool_upper}_BIN"

mode="${!mode_var:-host}"
host_bin="${!bin_var:-$default_host_bin}"
override_enabled="${RALPIX_WRAPPER_ENABLE_LOCAL_OVERRIDE:-1}"
override_dir="${RALPIX_WRAPPER_LOCAL_OVERRIDE_DIR:-/workspace/.devcontainer/bin}"
debug_enabled="${RALPIX_WRAPPER_DEBUG:-0}"
override_path="${override_dir}/${tool_name}"
self_path="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
override_real_path="$(readlink -f "${override_path}" 2>/dev/null || printf '%s' "${override_path}")"

log_debug() {
  if [ "${debug_enabled}" = "1" ]; then
    printf 'ralpix wrapper: %s\n' "$*" >&2
  fi
}

if [ "${override_enabled}" = "1" ] && [ -x "${override_path}" ] && [ "${override_real_path}" != "${self_path}" ]; then
  log_debug "delegating ${tool_name} to local override ${override_path}"
  exec "${override_path}" "$@"
fi

case "${mode}" in
  host)
    log_debug "forwarding ${tool_name} to host binary ${host_bin}"
    exec pi --host "${host_bin}" "$@"
    ;;
  container)
    log_debug "running ${tool_name} in container as ${host_bin}"
    exec "${host_bin}" "$@"
    ;;
  *)
    printf 'Unsupported %s wrapper mode: %s\n' "${tool_name}" "${mode}" >&2
    exit 64
    ;;
esac
