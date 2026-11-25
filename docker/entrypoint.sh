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
    "$T3CODE_HOME/.keyrings" \
    "$T3GW_PROVIDERS_DIR/npm-global" \
    "$T3GW_PROVIDERS_DIR/mise" \
    "$T3GW_PROVIDERS_DIR/mise-config" \
    "$CODER_HOME/.local/bin" \
    "$CODER_HOME/.local/share" \
    "$CODER_HOME/.config" \
    "$T3_WORKSPACE"

  # Persist unlocked GNOME keyring under $T3CODE_HOME/.keyrings so T3 Desktop's encrypted
  # connection-catalog.json and keyring secret stay paired across container recreations
  chmod 0700 "$T3CODE_HOME/.keyrings"
  if [ ! -f "$T3CODE_HOME/.keyrings/login.keyring" ]; then
    printf 'login' > "$T3CODE_HOME/.keyrings/default"
    printf '[keyring]\ndisplay-name=login\nctime=0\nmtime=0\nlock-on-idle=false\nlock-after=false\n' > "$T3CODE_HOME/.keyrings/login.keyring"
    chmod 0600 "$T3CODE_HOME/.keyrings/default" "$T3CODE_HOME/.keyrings/login.keyring"
  fi
  if [ ! -e "$CODER_HOME/.local/share/keyrings" ]; then
    ln -s "$T3CODE_HOME/.keyrings" "$CODER_HOME/.local/share/keyrings"
  fi
  if [ ! -e "$CODER_HOME/workspace" ] && [ ! -L "$CODER_HOME/workspace" ]; then
    ln -s "$T3_WORKSPACE" "$CODER_HOME/workspace"
  fi

  # 4. Seed bundled T3 Code release into persistent volume (and self-heal any broken slot launcher)
  if [ -d "/opt/t3-seed" ] && [ -f "/opt/t3-seed/.seed-version" ]; then
    seed_ver="$(cat /opt/t3-seed/.seed-version)"
    target_slot="$T3CODE_HOME/runtime/versions/$seed_ver"
    needs_seed=0
    if [ ! -f "$target_slot/.install-complete" ]; then
      needs_seed=1
    elif [ -f "$target_slot/t3-server-launcher" ] && ! "$target_slot/t3-server-launcher" --version >/dev/null 2>&1; then
      needs_seed=1
    elif [ ! -f "$target_slot/t3-server-launcher" ] && [ ! -x "$target_slot/t3" ]; then
      needs_seed=1
    fi

    if [ "$needs_seed" = "1" ]; then
      rm -rf "$target_slot"
      cp -a "/opt/t3-seed/slot" "$target_slot"
      printf '%s\n' "$seed_ver" > "$target_slot/.install-complete"
    fi
    if [ ! -L "$T3CODE_HOME/runtime/current" ] || [ ! -e "$T3CODE_HOME/runtime/current" ]; then
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
