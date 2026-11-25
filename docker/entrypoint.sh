#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
CODER_USER="coder"
CODER_HOME="${CODER_HOME:-/home/coder}"
T3GW_DATA_DIR="${T3GW_DATA_DIR:-/data/gateway}"
T3CODE_HOME="${T3CODE_HOME:-/data/t3}"
T3GW_PROVIDERS_DIR="${T3GW_PROVIDERS_DIR:-/data/providers}"
T3GW_SNAPSHOTS_DIR="${T3GW_SNAPSHOTS_DIR:-/data/snapshots}"
T3_WORKSPACE="${T3_WORKSPACE:-/workspace}"

# 1. Align unprivileged `coder` UID/GID with host PUID/PGID so bind-mounted /workspace stays clean
if [ "$(id -u)" = "0" ]; then
  current_gid="$(id -g "$CODER_USER" 2>/dev/null || echo 1000)"
  current_uid="$(id -u "$CODER_USER" 2>/dev/null || echo 1000)"
  if [ "$PGID" != "$current_gid" ]; then
    groupmod -o -g "$PGID" "$CODER_USER" 2>/dev/null || true
  fi
  if [ "$PUID" != "$current_uid" ]; then
    usermod -o -u "$PUID" "$CODER_USER" 2>/dev/null || true
  fi

  # 2. Enforce strict kernel DAC boundary: /data/gateway & /data/snapshots are 0700 (unreadable by coder/agents!)
  mkdir -p "$T3GW_DATA_DIR" "$T3GW_SNAPSHOTS_DIR"
  chmod 0700 "$T3GW_DATA_DIR" "$T3GW_SNAPSHOTS_DIR"
  chown root:root "$T3GW_DATA_DIR" "$T3GW_SNAPSHOTS_DIR"

  # 3. Prepare coder-owned persistent directories
  mkdir -p \
    "$T3CODE_HOME/userdata" \
    "$T3CODE_HOME/runtime/versions" \
    "$T3CODE_HOME/.staging" \
    "$T3GW_PROVIDERS_DIR/npm-global" \
    "$T3GW_PROVIDERS_DIR/mise" \
    "$T3GW_PROVIDERS_DIR/mise-config" \
    "$CODER_HOME/.local/bin" \
    "$CODER_HOME/.config" \
    "$T3_WORKSPACE"

  # 4. Seed bundled T3 Code release into persistent volume on first start
  if [ -d "/opt/t3-seed" ] && [ -f "/opt/t3-seed/.seed-version" ]; then
    seed_ver="$(cat /opt/t3-seed/.seed-version)"
    target_slot="$T3CODE_HOME/runtime/versions/$seed_ver"
    if [ ! -f "$target_slot/.install-complete" ]; then
      cp -a "/opt/t3-seed/slot" "$target_slot"
      printf '%s\n' "$seed_ver" > "$target_slot/.install-complete"
    fi
    if [ ! -L "$T3CODE_HOME/runtime/current" ]; then
      ln -sfn "$target_slot" "$T3CODE_HOME/runtime/current"
    fi
  fi

  chown -R "$PUID:$PGID" "$T3CODE_HOME" "$T3GW_PROVIDERS_DIR" "$CODER_HOME"
  chown "$PUID:$PGID" "$T3_WORKSPACE" 2>/dev/null || true
  export CODER_USER="coder"
fi

# Never export NODE_ENV, DISPLAY, LC_ALL, or LANGUAGE globally
unset NODE_ENV DISPLAY LC_ALL LANGUAGE ELECTRON_RUN_AS_NODE

exec node /opt/t3-gateway/packages/gateway/dist/index.js
