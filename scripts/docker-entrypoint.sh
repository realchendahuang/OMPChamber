#!/usr/bin/env sh
set -eu

HOME="/home/ompchamber"

# The server still reads the legacy OPENCODE_CONFIG_DIR name
# (packages/web/server/lib/ompchamber/shared.js).
OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${HOME}/.config/opencode}"
export OPENCODE_CONFIG_DIR

# The web CLI's serve preflight still resolves the agent binary via
# OPENCODE_BINARY (packages/web/bin/cli.js) while the server launches the OMP
# engine via OMP_BINARY (packages/web/server/index.js). Point both at the OMP
# CLI installed in the image.
if [ -z "${OMP_BINARY:-}" ] && command -v omp >/dev/null 2>&1; then
  OMP_BINARY="$(command -v omp)"
  export OMP_BINARY
fi
if [ -z "${OPENCODE_BINARY:-}" ] && [ -n "${OMP_BINARY:-}" ]; then
  OPENCODE_BINARY="${OMP_BINARY}"
  export OPENCODE_BINARY
fi

SSH_DIR="${HOME}/.ssh"
SSH_PRIVATE_KEY_PATH="${SSH_DIR}/id_ed25519"
SSH_PUBLIC_KEY_PATH="${SSH_PRIVATE_KEY_PATH}.pub"

mkdir -p "${SSH_DIR}"
if ! chmod 700 "${SSH_DIR}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_DIR}, continuing with existing permissions"
fi

if [ ! -f "${SSH_PRIVATE_KEY_PATH}" ] || [ ! -f "${SSH_PUBLIC_KEY_PATH}" ]; then
  if [ ! -w "${SSH_DIR}" ]; then
    echo "[entrypoint] warning: ssh key missing and ${SSH_DIR} is not writable, continuing without SSH key" >&2
  else
    echo "[entrypoint] generating SSH key..."
    if ! ssh-keygen -t ed25519 -N "" -f "${SSH_PRIVATE_KEY_PATH}" >/dev/null 2>&1; then
      echo "[entrypoint] warning: failed to generate SSH key, continuing without SSH key" >&2
    fi
  fi
fi

if ! chmod 600 "${SSH_PRIVATE_KEY_PATH}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_PRIVATE_KEY_PATH}, continuing"
fi

if ! chmod 644 "${SSH_PUBLIC_KEY_PATH}" 2>/dev/null; then
  echo "[entrypoint] warning: cannot chmod ${SSH_PUBLIC_KEY_PATH}, continuing"
fi

if [ -f "${SSH_PUBLIC_KEY_PATH}" ]; then
  echo "[entrypoint] SSH public key:"
  cat "${SSH_PUBLIC_KEY_PATH}"
fi

# Handle UI password environment variables. UI_PASSWORD is kept as a legacy
# alias; OMPCHAMBER_UI_PASSWORD is the canonical runtime variable.
if [ -z "${OMPCHAMBER_UI_PASSWORD:-}" ] && [ -n "${UI_PASSWORD:-}" ]; then
  OMPCHAMBER_UI_PASSWORD="$UI_PASSWORD"
  export OMPCHAMBER_UI_PASSWORD
fi

if [ -n "${OMPCHAMBER_UI_PASSWORD:-}" ]; then
  echo "[entrypoint] UI password set, enabling authentication"
fi

# The oh-my-opencode plugin installer was removed: it targets the OpenCode
# backend and cannot work with the OMP engine. Configure OMP extensions
# through the OMP CLI's own config instead.

# Docker containers need to listen on all interfaces for port mapping to work.
OMPCHAMBER_HOST="${OMPCHAMBER_HOST:-0.0.0.0}"
export OMPCHAMBER_HOST

echo "[entrypoint] starting..."

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

set -- bun packages/web/bin/cli.js
if [ -n "${OMPCHAMBER_UI_PASSWORD:-}" ]; then
  set -- "$@" --ui-password "$OMPCHAMBER_UI_PASSWORD"
fi
"$@"

exec bun packages/web/bin/cli.js logs
