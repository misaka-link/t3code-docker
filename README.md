# T3 Code Docker (`t3code-docker`)

专为官方 [T3 Code (`pingdotgg/t3code`)](https://github.com/pingdotgg/t3code) 打造的**生产级容器化套件与 1:1 官方同源风格 Web 安全网关**。

全仓采用 **100% TypeScript (`strict: true`) + Fastify + React 19 + Tailwind CSS v4** 构建，坚持**零侵入官方原版产物（Zero Monkey-Patching）**、**双镜像满血研发底座零阉割**与**内核级双 UID 安全隔离**。

---

## ✨ 核心亮点

- **🎨 1:1 复刻 T3 官方 WebUI 质感（默认简体中文）**：单端口（默认 `:3080`）统一承载 T3 Code 官方 WebUI（`/`）、管理控制台（默认 `/admin`，支持免重启热自定义）与按需虚拟桌面（默认 `/vnc`，支持热自定义）；内置编译期强类型中英双语切换与深浅色主题。
- **🔐 前置安全门禁与「零重复签发」无感桥接**：首次访问自动进入初始化设密向导（`scrypt` 哈希 + IP 防爆破限流）；`T3AuthBridge` 通过原生 `t3_session_*` Cookie 检测、Singleflight 并发互斥锁与持久化桌面会话对账，实现**输一次网关密码直进 WebUI 且绝不堆积重复会话**。
- **🔄 官方原版零补丁热更新与自动回滚**：支持 `Stable` / `Nightly` 双通道在线检测、校验官方 `SHA256SUMS` / `latest-linux*.yml (SHA-512)`、升级前自动快照、多版本缓存秒级切换；新版若未通过 30s 健康探针自动回滚上一正常版本。
- **☁️ 控制台直接管控 `T3 Connect` 开关**：内置无头设备码（Device-Code）可视化绑定弹窗，支持**保留授权免重登随时开/关云中继隧道**、手机端实时进度推送开关与新接入设备审批。
- **🖥️ 按需休眠 VNC 桌面、双端共生与纯标准浏览器 MCP**：
  - `:latest` 镜像内置默认 **0 MB 内存休眠**的虚拟桌面，唤醒后可同时运行 **T3 官方桌面版**（客户端模式直接挂载运行中的 `t3 serve`，WebUI 与桌面实时同步、关桌面不断任务）与**有头 Chromium**（完美闭环 `localhost` OAuth 登录 + 根治 Linux `LANGUAGE` 环境变量压制 `--lang` 问题）；
  - 提供零注入标准 **`@t3-docker/desktop-browser-mcp`**（AI 调用时自动秒级唤醒桌面，支持人机同屏接管过验证），同时双镜像均完整支持 T3 官方内置无头 `ServerBrowser`。
- **🛠️ 100% 满血零阉割多语言研发底座**：`:latest` 与 `:headless`（`:slim`）完全共享编译链（`build-essential`）、`git`/`gh`、`Node 22 LTS`、`Python3 + uv`、**`mise`**、**全彩 `Noto Color Emoji` + 中日韩字体**及无头预览库，原生支持 **`linux/amd64` + `linux/arm64`** 双架构。

---

## 📦 镜像变体对比

两款镜像共享 **100% 一致的满血研发与编译底座**，唯一差异仅为是否搭载虚拟桌面与有头 GUI 软件：

| 维度 | `:latest`（默认完整版） | `:headless` / `:slim`（无桌面版） |
| :--- | :---: | :---: |
| **研发编译链 (`gcc`/`git`/`gh`/`Node`/`uv`/`mise`/`rg`/`ffmpeg`)** | **100% 满血 ✅** | **100% 满血 ✅** |
| **全彩 Emoji (`Noto Color Emoji`) 与中日韩字体** | **100% 满血 ✅** | **100% 满血 ✅** |
| **T3 官方内置无头流式浏览器 (`preview_*` / `html_render`)** | **支持 ✅** | **支持 ✅** |
| **网关后台、版本热更新、T3 Connect、Providers 管理、快照还原** | **支持 ✅** | **支持 ✅** |
| **按需休眠 VNC 虚拟桌面 (`/vnc`) + 有头 Chromium + T3 桌面版** | **内置 ✅ (默认休眠 0 内存)** | **物理剥离 ❌ (后台自动隐藏桌面页)** |
| **支持架构** | `linux/amd64` + `linux/arm64` | `linux/amd64` + `linux/arm64` |

---

## 🚀 快速启动

### 方式一：单文件全参数 `docker-compose.yml`（无需单独 `.env` 文件，复制即用）

无需克隆仓库或额外创建 `.env` 文件，只需新建一个目录并保存以下包含**全部可调参数与注释**的 `docker-compose.yml`，执行 `docker compose up -d` 即可启动（所有留空或默认项均已内置安全解析）：

```yaml
services:
  t3code:
    # 默认完整版（含按需休眠 VNC 桌面与有头 Chromium）
    # 如仅需无桌面满血研发环境，可改为: ghcr.io/misaka-link/t3code-docker:headless
    image: ghcr.io/misaka-link/t3code-docker:latest
    container_name: t3code
    restart: unless-stopped
    init: true
    # Chromium / Electron 共享内存，避免复杂页面或长会话渲染崩溃
    shm_size: "1gb"
    # 留足优雅停机窗口，确保 SQLite WAL 与进行中的快照安全落盘
    stop_grace_period: 45s
    pids_limit: 4096

    ports:
      # 单一统一端口（共享 T3 Code 官方 WebUI `/`, 管理后台 `/admin` 与按需虚拟桌面 `/vnc`）
      - "3080:3080"

    environment:
      # -------------------- 1. 端口与前置安全门禁 --------------------
      # 容器内网关监听地址与端口（如修改宿主机映射左侧端口即可，一般保持 3080）
      PROXY_HOST: "0.0.0.0"
      PROXY_PORT: "3080"
      # 管理员初始访问口令：
      # - 留空 ""（推荐）：首次浏览器访问自动进入可视化「初始化设密向导」，口令经 scrypt 哈希安全落盘
      # - 填写明文：跳过向导直接使用该初始口令（网关启动瞬间即从内存 env 擦除，绝不泄漏给子进程）
      AUTH_TOKEN: ""
      # Cookie HMAC 签名密钥（留空则首次启动自动生成 256-bit 随机密钥并持久化至 /data/gateway）
      SESSION_SECRET: ""

      # -------------------- 2. 路由、默认语言与更新通道 --------------------
      # 管理后台路径与按需虚拟桌面路径（必须以 / 开头，不可占用 /pair、/api、/mcp、/_t3gw；登录后亦可免重启热改）
      ADMIN_PATH: "/admin"
      VNC_PATH: "/vnc"
      # 首次初始化默认界面与浏览器语言：zh-CN（默认简体中文）| en-US（英文）
      DEFAULT_LOCALE: "zh-CN"
      # 默认 T3 Code 版本在线检测通道：stable（稳定版）| nightly（每夜预览版）
      RELEASE_CHANNEL: "stable"
      # 在线切换版本前要求的最低剩余磁盘空间（MB）
      VERSIONS_MIN_FREE_MB: "1536"

      # -------------------- 3. 宿主机权限与预装工具策略 --------------------
      # 工作平面非特权用户 coder 的 UID/GID（与宿主机当前用户对齐，保持 /workspace 代码属主干净）
      PUID: "1000"
      PGID: "1000"
      TZ: "Asia/Shanghai"
      # 首次启动后台自动安装至持久化卷的编码 Agent CLI 策略：
      # - core : 默认安装 Claude Code、Codex、OpenCode
      # - all  : 安装内置目录支持的全部 Agent CLI
      # - none : 不自动预装，进入后台可视化面板按需一键安装
      T3_PREINSTALL: "core"

      # -------------------- 4. 按需休眠 VNC 虚拟桌面参数（仅 :latest 生效） --------------------
      # 虚拟桌面默认分辨率与无连接空闲自动休眠分钟数（设为 0 则禁用自动休眠）
      DESKTOP_WIDTH: "1920"
      DESKTOP_HEIGHT: "1080"
      DESKTOP_IDLE_MINUTES: "30"

      # -------------------- 5. 反向代理与公网访问（可选） --------------------
      # 部署在 Nginx / Caddy / Traefik / Cloudflare Tunnel 后方时设为 "1"，以正确识别客户端真实 IP 与 HTTPS
      TRUST_PROXY: "0"
      # 外部公网访问基准地址（例如 "https://t3.example.com"，用于生成外部扫码配对链接与同源校验）
      PUBLIC_URL: ""

      # -------------------- 6. 工作平面出站网络代理（可选，后台亦可热改） --------------------
      HTTP_PROXY: ""
      HTTPS_PROXY: ""
      ALL_PROXY: ""
      NO_PROXY: "localhost,127.0.0.1,::1"

      # -------------------- 7. 内部上游端口（通常无需改动） --------------------
      T3_UPSTREAM_HOST: "127.0.0.1"
      T3_UPSTREAM_PORT: "3773"
      NOVNC_UPSTREAM_PORT: "6080"

    # 最小权限安全加固：禁止 SUID 提权，仅保留初始化目录属主与 gosu 降权所需的最小能力集
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - DAC_OVERRIDE
      - FOWNER
      - SETUID
      - SETGID
      - KILL

    volumes:
      # 1. 网关安全凭据与配置目录（0700 root 独占，AI Agent 与终端子进程物理不可读）
      - ./data/gateway:/data/gateway
      # 2. T3 Code 核心数据与多版本槽位目录（SQLite 数据库、T3 Connect 授权、runtime/versions）
      - ./data/t3:/data/t3
      # 3. 持久化编码 Agent CLI 与 mise 多语言工具链目录（容器重建无需重装 CLI）
      - ./data/providers:/data/providers
      # 4. coder 用户主目录（持久化 ~/.claude、~/.codex、~/.config、SSH/Git 等登录态）
      - ./data/home:/home/coder
      # 5. 自动升级前备份与手动快照归档目录（0700 隔离保护）
      - ./data/snapshots:/data/snapshots
      # 6. 默认代码研发工作区
      - ./workspace:/workspace

    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "3"
```

### 方式二：克隆仓库配合 `.env` 模板部署

```bash
git clone https://github.com/misaka-link/t3code-docker.git
cd t3code-docker
cp .env.example .env

# 启动默认完整版（含按需休眠 VNC 桌面与有头浏览器）
docker compose up -d

# 或启动无桌面满血研发版
docker compose -f docker-compose.headless.yml up -d
```

### 方式三：单行 `docker run`

```bash
docker run -d \
  --name t3code \
  --restart unless-stopped \
  --init \
  --shm-size 1gb \
  --stop-timeout 45 \
  -p 3080:3080 \
  -v "$PWD/data/gateway:/data/gateway" \
  -v "$PWD/data/t3:/data/t3" \
  -v "$PWD/data/providers:/data/providers" \
  -v "$PWD/data/home:/home/coder" \
  -v "$PWD/data/snapshots:/data/snapshots" \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/misaka-link/t3code-docker:latest
```

启动后浏览器访问：
- **T3 Code 工作区**：`http://<服务器IP>:3080/`（首次打开自动引导初始化设置访问口令）
- **网关管理控制台**：`http://<服务器IP>:3080/admin`
- **按需虚拟桌面**：`http://<服务器IP>:3080/vnc` *(仅 `:latest` 镜像)*

---

## ⚙️ 全量环境变量速查表

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PROXY_PORT` / `PROXY_HOST` | `3080` / `0.0.0.0` | 单一统一对外监听端口与绑定地址（WebUI、Admin 与 VNC 共用） |
| `AUTH_TOKEN` | *(留空)* | 初始访问口令；留空则首次打开网页进入可视化设密向导 |
| `SESSION_SECRET` | *(留空自动生成)* | 网关管理员 Cookie 签名密钥，落盘于 `/data/gateway` |
| `ADMIN_PATH` | `/admin` | 管理控制台路径（支持后台免重启热修改） |
| `VNC_PATH` | `/vnc` | 虚拟桌面路径（支持后台免重启热修改） |
| `DEFAULT_LOCALE` | `zh-CN` | 首次启动默认语言（`zh-CN` / `en-US`） |
| `RELEASE_CHANNEL` | `stable` | 默认 T3 Code 更新检测通道（`stable` / `nightly`） |
| `VERSIONS_MIN_FREE_MB` | `1536` | 安装新版本前最低剩余磁盘空间阈值（MB） |
| `PUID` / `PGID` | `1000` / `1000` | 工作平面 `coder` 用户 UID/GID，保持宿主机 `/workspace` 属主干净 |
| `TZ` | `Asia/Shanghai` | 容器与日志时区 |
| `T3_PREINSTALL` | `core` | 首次启动自动安装至持久化卷的 Agent CLI（`core` / `all` / `none`） |
| `DESKTOP_WIDTH` / `DESKTOP_HEIGHT` | `1920` / `1080` | VNC 虚拟桌面默认分辨率 |
| `DESKTOP_IDLE_MINUTES` | `30` | VNC 无活跃连接自动休眠分钟数（`0` 为不自动休眠） |
| `TRUST_PROXY` | `0` | 部署于可信反向代理后方时设为 `1` |
| `PUBLIC_URL` | *(空)* | 外部访问基准 URL（用于生成外部扫码配对链接与 Origin 校验） |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | *(空)* | 工作平面出站网络代理 |
| `NO_PROXY` | `localhost,127.0.0.1,::1` | 免代理直连白名单 |

---

## 🛠️ 本地开发与测试

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

更多底层安全边界、防重签协议状态机与模块设计请查阅：**[系统架构与工程规划设计书 (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md)**。
