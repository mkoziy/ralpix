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
ssh_bin="${RALPIX_HOST_SSH_BIN:-ssh}"
ssh_target="${RALPIX_HOST_SSH_TARGET:-host.docker.internal}"
host_workdir="${RALPIX_HOST_WORKDIR:-}"
allowed_root="${RALPIX_HOST_ALLOWED_ROOT:-$host_workdir}"
host_path="${RALPIX_HOST_PATH:-/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin}"
override_path="${override_dir}/${tool_name}"
self_path="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
override_real_path="$(readlink -f "${override_path}" 2>/dev/null || printf '%s' "${override_path}")"

log_debug() {
  if [ "${debug_enabled}" = "1" ]; then
    printf 'ralpix wrapper: %s\n' "$*" >&2
  fi
}

require_host_config() {
  if [ -z "${host_workdir}" ]; then
    printf 'ralpix wrapper: host workdir is required for host mode. Set RALPIX_HOST_WORKDIR to the host project path.\n' >&2
    exit 64
  fi

  if [ -z "${allowed_root}" ]; then
    printf 'ralpix wrapper: host allowed root is required for host mode. Set RALPIX_HOST_ALLOWED_ROOT or RALPIX_HOST_WORKDIR.\n' >&2
    exit 64
  fi
}

run_host_over_ssh() {
  require_host_config

  log_debug "forwarding ${tool_name} to host via ${ssh_bin} ${ssh_target} (workdir: ${host_workdir}, allowed root: ${allowed_root})"

  exec "${ssh_bin}" -o BatchMode=yes "${ssh_target}" sh -s -- \
    "${allowed_root}" \
    "${host_workdir}" \
    "${host_path}" \
    "${host_bin}" \
    "$@" <<'EOF'
set -euo pipefail

allowed_root="$1"
shift
host_workdir="$1"
shift
host_path="$1"
shift
tool="$1"
shift

canonical_dir() {
  local path="$1"

  if [ ! -d "${path}" ]; then
    printf 'ralpix wrapper: host path does not exist: %s\n' "${path}" >&2
    exit 64
  fi

  cd "${path}"
  pwd -P
}

require_under_root() {
  local root="$1"
  local path="$2"

  case "${path}" in
    "${root}"|"${root}"/*)
      ;;
    *)
      printf 'ralpix wrapper: host workdir %s is outside allowed root %s\n' "${path}" "${root}" >&2
      exit 64
      ;;
  esac
}

allowed_root_real="$(canonical_dir "${allowed_root}")"
host_workdir_real="$(canonical_dir "${host_workdir}")"
require_under_root "${allowed_root_real}" "${host_workdir_real}"

export PATH="${host_path}:/usr/bin:/bin"
export HOME="${host_workdir_real}/.ralpix-host-home"
mkdir -p "${HOME}"
cd "${host_workdir_real}"

exec "${tool}" "$@"
EOF
}

if [ "${override_enabled}" = "1" ] && [ -x "${override_path}" ] && [ "${override_real_path}" != "${self_path}" ]; then
  log_debug "delegating ${tool_name} to local override ${override_path}"
  exec "${override_path}" "$@"
fi

case "${mode}" in
  host)
    run_host_over_ssh "$@"
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
