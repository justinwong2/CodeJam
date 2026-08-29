#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) host_os=windows ;;
  Darwin) host_os=macos ;;
  *) host_os=linux ;;
esac

if [[ "$host_os" == "windows" ]]; then
  # Git Bash otherwise rewrites container-side paths such as dst=/workspace
  # into Windows paths before the engine ever sees them.
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
fi

# Git Bash speaks POSIX paths, but the Node control plane and the container
# engine are native Windows programs. Mixed form (C:/dir) is the one spelling
# all three accept.
to_host_path() {
  if [[ "$host_os" == "windows" ]]; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

runtime_image="${CONTAINER_RUNTIME_IMAGE:-volc-agent-runtime:local}"
runtime_base_image="${CONTAINER_RUNTIME_BASE_IMAGE:-node:22-bookworm-slim}"
runtime_apt_mirror="${CONTAINER_APT_MIRROR:-}"
runtime_apt_security_mirror="${CONTAINER_APT_SECURITY_MIRROR:-}"
runtime_apt_packages="${CONTAINER_RUNTIME_APT_PACKAGES:-ca-certificates git ripgrep}"
codex_sandbox_mode="${CODEX_SANDBOX_MODE:-workspace-write}"

log() {
  printf '[local-poc] %s\n' "$*" >&2
}

engine_works() {
  "$1" info >/dev/null 2>&1
}

detect_engine() {
  if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
    command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || {
      log "CONTAINER_ENGINE=$CONTAINER_ENGINE was not found."
      return 1
    }
    engine_works "$CONTAINER_ENGINE" || {
      log "$CONTAINER_ENGINE is installed but its service is not running."
      return 1
    }
    printf '%s' "$CONTAINER_ENGINE"
    return
  fi

  if command -v docker >/dev/null 2>&1 && engine_works docker; then
    printf 'docker'
    return
  fi

  if command -v colima >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
    log "Docker is not reachable; starting Colima."
    colima start >&2
    if engine_works docker; then
      printf 'docker'
      return
    fi
  fi

  if command -v podman >/dev/null 2>&1; then
    if ! engine_works podman && [[ "$host_os" == "macos" ]]; then
      log "Podman is not reachable; starting its macOS machine."
      podman machine start >&2 || true
    fi
    if engine_works podman; then
      printf 'podman'
      return
    fi
  fi

  log "No running Docker, Colima, or Podman engine was found."
  log "Install one of them, start it, and rerun this command."
  return 1
}

# Credentials may live in .env. Only credentials are read from it: the POC owns
# its own runtime settings and must not inherit the Compose values for HOST,
# RUNTIME_PROVIDER, or the state directories. Anything already exported wins.
load_env_credentials() {
  [[ -f .env ]] || return 0
  local name value
  for name in ARK_API_KEY ARK_MODEL ARK_BASE_URL APP_AUTH_TOKEN; do
    if [[ -z "${!name:-}" ]]; then
      value="$(sed -n "s/^[[:space:]]*${name}=//p" .env | tail -n 1)"
      value="${value%$'\r'}"
      value="${value#\"}"
      value="${value%\"}"
      value="${value#\'}"
      value="${value%\'}"
      if [[ -n "$value" ]]; then
        export "$name=$value"
      fi
    fi
  done
  return 0
}
load_env_credentials

if [[ -z "${ARK_API_KEY:-}" || -z "${ARK_MODEL:-}" ]]; then
  log "ARK_API_KEY and ARK_MODEL are required."
  log "Set them in .env, or pass them inline:"
  log "  ARK_API_KEY=key ARK_MODEL=ep-id npm run poc"
  exit 2
fi

command -v node >/dev/null 2>&1 || {
  log "Node.js 22+ is required to run the local control plane."
  exit 2
}

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  log "Node.js 22+ is required; found $(node --version)."
  exit 2
fi

engine="$(detect_engine)"
log "Using $engine as the Agent Runtime engine."

if [[ ! -d node_modules ]]; then
  log "Installing application dependencies."
  npm ci
fi

if [[ -n "${LOCAL_POC_DATA_ROOT:-}" ]]; then
  local_state_root="$LOCAL_POC_DATA_ROOT"
  APP_DATA_DIR="$local_state_root/data"
  AGENT_WORKSPACE_ROOT="$local_state_root/workspaces"
  CODEX_HOME="$local_state_root/codex-home"
else
  if [[ "$host_os" == "macos" ]]; then
    local_state_root="${HOME}/.volc-agent-launchpad"
  else
    local_state_root="$repo_dir/.local"
  fi
  APP_DATA_DIR="${APP_DATA_DIR:-$local_state_root/data}"
  AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}"
  CODEX_HOME="${CODEX_HOME:-$local_state_root/codex-home}"
fi
export RUNTIME_INSTANCE_ID="${RUNTIME_INSTANCE_ID:-local-$(id -u)-$(printf '%s' "$repo_dir" | cksum | awk '{print $1}')}"

mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME"
APP_DATA_DIR="$(to_host_path "$APP_DATA_DIR")"
AGENT_WORKSPACE_ROOT="$(to_host_path "$AGENT_WORKSPACE_ROOT")"
CODEX_HOME="$(to_host_path "$CODEX_HOME")"
export APP_DATA_DIR AGENT_WORKSPACE_ROOT CODEX_HOME
log "Persistent state: $local_state_root"

if [[ "$host_os" == "windows" ]]; then
  # Docker Desktop bind mounts ignore host UID/GID, and the MSYS uid is not a
  # real Linux one. Use the same default the control plane picks on Windows.
  export CONTAINER_USER="${CONTAINER_USER:-1000:1000}"
else
  export CONTAINER_USER="${CONTAINER_USER:-$(id -u):$(id -g)}"
fi

log "Building $runtime_image from Dockerfile.runtime (base: $runtime_base_image)."
"$engine" build \
  --file Dockerfile.runtime \
  --build-arg "NODE_IMAGE=$runtime_base_image" \
  --build-arg "DEBIAN_MIRROR=$runtime_apt_mirror" \
  --build-arg "DEBIAN_SECURITY_MIRROR=$runtime_apt_security_mirror" \
  --build-arg "RUNTIME_APT_PACKAGES=$runtime_apt_packages" \
  --tag "$runtime_image" \
  .

log "Checking that the Runtime can bind-mount the configured state directories."
preflight_user_args=(--user "$CONTAINER_USER")
if [[ "$(basename "$engine")" == "podman" ]]; then
  preflight_user_args+=(--userns keep-id)
fi
if ! "$engine" run --rm \
  "${preflight_user_args[@]}" \
  --mount "type=bind,src=$AGENT_WORKSPACE_ROOT,dst=/workspace" \
  --mount "type=bind,src=$CODEX_HOME,dst=/codex-home" \
  "$runtime_image" sh -lc \
    'touch /workspace/.launchpad-write-test /codex-home/.launchpad-write-test && rm /workspace/.launchpad-write-test /codex-home/.launchpad-write-test'; then
  log "The container engine cannot mount $local_state_root."
  log "Set LOCAL_POC_DATA_ROOT to a directory shared with Docker/Colima/Podman."
  exit 2
fi

if [[ "$codex_sandbox_mode" == "workspace-write" ]] \
  && ! "$engine" run --rm "$runtime_image" \
    codex sandbox linux --full-auto -- true >/dev/null 2>&1; then
  log "Codex Landlock is unavailable in this Linux Runtime."
  log "Falling back to danger-full-access inside the disposable container boundary."
  log "Do not mount unrelated secrets or host directories into the Agent Runtime."
  codex_sandbox_mode=danger-full-access
fi

export NODE_ENV=production
# The disposable Runtime calls the Agent Access Gateway through the container
# host alias (host.docker.internal / host.containers.internal), which arrives on
# a host interface that is never loopback. A 127.0.0.1 bind would make every
# model call fail, so the POC listens on all interfaces.
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"

# Listening beyond loopback in production requires the shared browser token.
# Mint an ephemeral one for this run when the operator has not configured a real
# one, so the wider bind never leaves the control plane unauthenticated.
generated_auth_token=0
case "$HOST" in
  127.0.0.1 | localhost | ::1) ;;
  *)
    if [[ -z "${APP_AUTH_TOKEN:-}" || "${APP_AUTH_TOKEN}" == replace-* \
      || ${#APP_AUTH_TOKEN} -lt 24 ]]; then
      APP_AUTH_TOKEN="$(node -e \
        "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))")"
      export APP_AUTH_TOKEN
      generated_auth_token=1
    fi
    ;;
esac
export CODEX_SANDBOX_MODE="$codex_sandbox_mode"
export RUNTIME_PROVIDER=container
export CONTAINER_ENGINE="$engine"
export CONTAINER_RUNTIME_IMAGE="$runtime_image"

cleanup() {
  local container_ids
  container_ids="$($engine ps --all --quiet \
    --filter label=io.codejam.launchpad=agent-runtime \
    --filter "label=io.codejam.instance-id=$RUNTIME_INSTANCE_ID" 2>/dev/null || true)"
  if [[ -n "$container_ids" ]]; then
    log "Removing remaining Agent Runtime containers for $RUNTIME_INSTANCE_ID."
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] && "$engine" rm --force "$container_id" >/dev/null 2>&1 || true
    done <<<"$container_ids"
  fi
}
trap cleanup EXIT INT TERM

# Recover cleanly after a terminal or server crash from a previous local run.
cleanup

log "Building the local Web and API."
npm run build

log "Open http://localhost:$PORT"
if [[ "$generated_auth_token" == 1 ]]; then
  log "This run generated a browser access token because the server listens"
  log "beyond loopback. Paste it into the unlock screen, and set your own"
  log "APP_AUTH_TOKEN in .env to skip this:"
  log "  $APP_AUTH_TOKEN"
fi
npm start
