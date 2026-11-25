# ==============================================================================
# t3code-docker Multi-Stage Production Dockerfile
# Shared 100% uncrippled `base-dev` foundation -> `headless` & `full` variants
# Native multi-arch support: linux/amd64 & linux/arm64
# ==============================================================================

ARG NODE_IMAGE=node:22-trixie-slim

# ------------------------------------------------------------------------------
# Stage 1: gateway-builder — Compiles TypeScript Gateway, MCP & React Console
# ------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS gateway-builder

WORKDIR /build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/desktop-browser-mcp/package.json packages/desktop-browser-mcp/tsconfig.json ./packages/desktop-browser-mcp/
COPY packages/console/package.json packages/console/tsconfig.json packages/console/vite.config.ts packages/console/index.html ./packages/console/
COPY packages/gateway/package.json packages/gateway/tsconfig.json ./packages/gateway/

RUN pnpm install --frozen-lockfile

COPY packages/shared/src ./packages/shared/src
COPY packages/desktop-browser-mcp/src ./packages/desktop-browser-mcp/src
COPY packages/console/src ./packages/console/src
COPY packages/gateway/src ./packages/gateway/src

RUN pnpm build && pnpm prune --prod

# ------------------------------------------------------------------------------
# Stage 2: base-dev — 100% Full Uncrippled Dev Workstation Foundation (Shared!)
# ------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base-dev

ARG TARGETARCH
ARG SUITE_VERSION=0.1.0
ENV DEBIAN_FRONTEND=noninteractive

# 1. Core system, compiler toolchain, developer CLIs, T3 ServerBrowser 17 t64 libs & CJK + Color Emoji fonts
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      tini \
      gosu \
      ca-certificates \
      curl \
      wget \
      dpkg \
      gnupg \
      locales \
      tzdata \
      procps \
      psmisc \
      iproute2 \
      openssh-client \
      git \
      git-lfs \
      build-essential \
      pkg-config \
      python3 \
      python-is-python3 \
      ripgrep \
      fd-find \
      jq \
      less \
      file \
      rsync \
      zip \
      unzip \
      p7zip-full \
      pigz \
      sqlite3 \
      ffmpeg \
      fontconfig \
      fonts-wqy-zenhei \
      fonts-wqy-microhei \
      fonts-noto-color-emoji \
      fonts-symbola \
      libnss3 \
      libglib2.0-0t64 \
      libatk1.0-0t64 \
      libatk-bridge2.0-0t64 \
      libatspi2.0-0t64 \
      libdbus-1-3 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxrandr2 \
      libxkbcommon0 \
      libgbm1 \
      libasound2t64 \
      libexpat1; \
    # Install GitHub CLI (gh)
    mkdir -p -m 755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update && apt-get install -y --no-install-recommends gh; \
    # Generate multi-language UTF-8 locales (NEVER lock global LC_ALL or LANGUAGE!)
    sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen; \
    sed -i 's/^# *\(zh_CN.UTF-8 UTF-8\)/\1/' /etc/locale.gen; \
    sed -i 's/^# *\(zh_TW.UTF-8 UTF-8\)/\1/' /etc/locale.gen; \
    sed -i 's/^# *\(ja_JP.UTF-8 UTF-8\)/\1/' /etc/locale.gen; \
    locale-gen; \
    # Lock Fontconfig fallback priority: CJK -> Noto Color Emoji -> Symbola (zero tofu / zero monochrome downgrade)
    mkdir -p /etc/fonts; \
    printf '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <alias>\n    <family>sans-serif</family>\n    <prefer>\n      <family>WenQuanYi Zen Hei</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>serif</family>\n    <prefer>\n      <family>WenQuanYi Zen Hei</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>monospace</family>\n    <prefer>\n      <family>WenQuanYi Micro Hei Mono</family>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n  <alias>\n    <family>emoji</family>\n    <prefer>\n      <family>Noto Color Emoji</family>\n      <family>Symbola</family>\n    </prefer>\n  </alias>\n</fontconfig>\n' > /etc/fonts/local.conf; \
    fc-cache -fv; \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 2. Install `uv` (Python manager) & `mise` (per-project Go/Rust/Bun/Deno/Forge CLI manager) + corepack
RUN set -eux; \
    corepack enable; \
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh; \
    curl -fsSL https://mise.run | env MISE_INSTALL_PATH=/usr/local/bin/mise sh; \
    uv --version && mise --version

# 3. Repurpose uid 1000 (`node`) cleanly into unprivileged `coder` user
RUN set -eux; \
    if id -u node >/dev/null 2>&1; then \
      usermod -l coder -d /home/coder -m node; \
      groupmod -n coder node; \
    else \
      groupadd -g 1000 coder && useradd -u 1000 -g 1000 -m -s /bin/bash coder; \
    fi

# 4. Copy compiled Gateway, Console static bundle, MCP wrapper & scripts
COPY --from=gateway-builder /build /opt/t3-gateway
COPY docker/scripts/bootstrap-t3-server.mjs /opt/t3-gateway/bootstrap-t3-server.mjs
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

ENV PROXY_PORT=3080 \
    T3_UPSTREAM_PORT=3773 \
    T3GW_DATA_DIR=/data/gateway \
    T3CODE_HOME=/data/t3 \
    T3GW_PROVIDERS_DIR=/data/providers \
    T3GW_SNAPSHOTS_DIR=/data/snapshots \
    T3_WORKSPACE=/workspace \
    CODER_HOME=/home/coder \
    CONSOLE_DIST_DIR=/opt/t3-gateway/packages/console/dist \
    LANG=C.UTF-8

WORKDIR /workspace
EXPOSE 3080

HEALTHCHECK --interval=20s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PROXY_PORT}/_t3gw/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]

# ------------------------------------------------------------------------------
# Stage 3A: headless — Full Dev Environment WITHOUT Virtual Desktop / Headed GUI
# ------------------------------------------------------------------------------
FROM base-dev AS headless

ARG TARGETARCH
ARG T3_CHANNEL=stable
ARG T3_VERSION=""

ENV T3GW_VARIANT=headless
LABEL org.opencontainers.image.variant="headless"

RUN set -eux; \
    T3CODE_CHANNEL="${T3_CHANNEL}" T3CODE_VERSION="${T3_VERSION}" \
    T3CODE_HOME="/tmp/t3-install" T3CODE_INSTALL_BIN_DIR="/tmp/t3-bin" \
    sh -c "$(curl -fsSL https://t3.codes/install.sh)"; \
    ver="$(ls -1 /tmp/t3-install/runtime/versions | head -n 1)"; \
    mkdir -p /opt/t3-seed; \
    mv "/tmp/t3-install/runtime/versions/${ver}" /opt/t3-seed/slot; \
    printf '%s\n' "${ver}" > /opt/t3-seed/.seed-version; \
    rm -rf /tmp/t3-install /tmp/t3-bin

# ------------------------------------------------------------------------------
# Stage 3B: full (Default :latest) — Adds On-Demand VNC Desktop, Chromium & T3 Desktop
# ------------------------------------------------------------------------------
FROM base-dev AS full

ARG TARGETARCH
ARG T3_VERSION=""

ENV T3GW_VARIANT=full
LABEL org.opencontainers.image.variant="full"

# 1. Install lightweight X11/VNC stack + headed Chromium with multi-language .pak packs
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      xvfb \
      openbox \
      x11-utils \
      x11vnc \
      novnc \
      websockify \
      libgtk-3-0t64 \
      libnotify4 \
      libsecret-1-0 \
      chromium \
      chromium-l10n; \
    if [ ! -e /usr/share/novnc/index.html ]; then \
      ln -s vnc.html /usr/share/novnc/index.html; \
    fi; \
    find /usr/lib/chromium/locales -mindepth 1 -maxdepth 1 -type f \
      ! -name 'zh-CN.pak' ! -name 'zh-TW.pak' ! -name 'en-US.pak' ! -name 'en-GB.pak' \
      ! -name 'ja.pak' ! -name 'ko.pak' ! -name 'es.pak' ! -name 'fr.pak' \
      ! -name 'de.pak' ! -name 'ru.pak' ! -name 'pt-BR.pak' -delete 2>/dev/null || true; \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# 2. Seed official T3 Code Desktop (.deb) unpacked cleanly for dual WebUI + VNC Desktop use
RUN set -eux; \
    deb_arch="$([ "${TARGETARCH:-amd64}" = "arm64" ] && echo arm64 || echo amd64)"; \
    ver="${T3_VERSION}"; \
    if [ -z "${ver}" ]; then \
      ver="$(curl -fsSL -H 'Accept: application/json' https://github.com/pingdotgg/t3code/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -n 1)"; \
    fi; \
    mkdir -p /tmp/t3-deb /opt/t3-seed/slot; \
    deb_file="T3-Code-${ver}-${deb_arch}.deb"; \
    base_url="https://github.com/pingdotgg/t3code/releases/download/v${ver}"; \
    curl -fsSL "${base_url}/SHA256SUMS" -o /tmp/t3-deb/SHA256SUMS; \
    expected="$(grep " \*\{0,1\}${deb_file}\$" /tmp/t3-deb/SHA256SUMS | cut -d' ' -f1)"; \
    curl -fsSL "${base_url}/${deb_file}" -o "/tmp/t3-deb/${deb_file}"; \
    actual="$(sha256sum "/tmp/t3-deb/${deb_file}" | cut -d' ' -f1)"; \
    [ "${actual}" = "${expected}" ]; \
    dpkg-deb -x "/tmp/t3-deb/${deb_file}" /opt/t3-seed/slot; \
    app_dir="/opt/t3-seed/slot/opt/T3 Code"; \
    [ -d "${app_dir}" ] || app_dir="/opt/t3-seed/slot/opt/T3 Code (Nightly)"; \
    exe_path="${app_dir}/t3-code"; \
    [ -x "${exe_path}" ] || exe_path="${app_dir}/t3-code-nightly"; \
    entry_mjs="${app_dir}/resources/server.asar/apps/server/dist/bin.mjs"; \
    [ -f "${entry_mjs}" ] || entry_mjs="${app_dir}/resources/app.asar/apps/server/dist/bin.mjs"; \
    rel_app="${app_dir#/opt/t3-seed/slot/}"; \
    rel_exe="${exe_path#/opt/t3-seed/slot/}"; \
    rel_entry="${entry_mjs#/opt/t3-seed/slot/}"; \
    printf '#!/bin/sh\nslot_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexport ELECTRON_RUN_AS_NODE=1\nexport T3_SERVER_ENTRY_MJS="${slot_dir}/%s"\nexec "${slot_dir}/%s" /opt/t3-gateway/bootstrap-t3-server.mjs "$@"\n' "${rel_entry}" "${rel_exe}" > /opt/t3-seed/slot/t3-server-launcher; \
    chmod 0755 /opt/t3-seed/slot/t3-server-launcher; \
    printf '%s\n' "${ver}" > /opt/t3-seed/.seed-version; \
    rm -rf /tmp/t3-deb
