#!/usr/bin/env bash

DEVCONTAINER_BIN="/workspace/.devcontainer/bin"

if [ -d "${DEVCONTAINER_BIN}" ]; then
  case ":$PATH:" in
    *":${DEVCONTAINER_BIN}:"*) ;;
    *) export PATH="${DEVCONTAINER_BIN}:$PATH" ;;
  esac
fi
