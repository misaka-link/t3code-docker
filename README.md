# T3 Code Docker (`t3code-docker`)

[![CI & Multi-Arch Docker Build](https://github.com/misaka-link/t3code-docker/actions/workflows/docker-build.yml/badge.svg)](https://github.com/misaka-link/t3code-docker/actions/workflows/docker-build.yml)
[![GHCR Package](https://img.shields.io/badge/GHCR-ghcr.io%2Fmisaka--link%2Ft3code--docker-2496ED?logo=docker&logoColor=white)](https://github.com/misaka-link/t3code-docker/pkgs/container/t3code-docker)

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

## 📦 官方 GitHub Actions 编译镜像地址与变体对比

镜像由 GitHub Actions 原生 `amd64` + `arm64` 双架构自动编译并公开发布于 **[GitHub Container Registry (`t3code-docker`)](https://github.com/misaka-link/t3code-docker/pkgs/container/t3code-docker)**：

```bash
# 默认完整版（满血研发环境 + 按需休眠 VNC 桌面 + 有头 Chromium + T3 桌面版）
docker pull ghcr.io/misaka-link/t3code-docker:latest

# 无桌面版（100% 同款满血研发环境，物理移除 VNC / GUI 组件；亦可使用 :slim 别名）
docker pull ghcr.io/misaka-link/t3code-docker:headless
```

两款镜像共享 **100% 一致的满血研发与编译底座**，唯一差异仅为是否搭载虚拟桌面与有头 GUI 软件：

| 维度 | `ghcr.io/misaka-link/t3code-docker:latest`（默认完整版） | `ghcr.io/misaka-link/t3code-docker:headless`（别名 `:slim`） |
| :--- | :---: | :---: |
| **镜像主页** | [查看 GHCR 镜像包](https://github.com/misaka-link/t3code-docker/pkgs/container/t3code-docker) | [查看 GHCR 镜像包](https://github.com/misaka-link/t3code-docker/pkgs/container/t3code-docker) |
| **研发编译链 (`gcc`/`git`/`gh`/`Node`/`uv`/`mise`/`rg`/`ffmpeg`)** | **100% 满血 ✅** | **100% 满血 ✅** |
| **全彩 Emoji (`Noto Color Emoji`) 与中日韩字体** | **100% 满血 ✅** | **100% 满血 ✅** |
| **T3 官方内置无头流式浏览器 (`preview_*` / `html_render`)** | **支持 ✅** | **支持 ✅** |
| **网关后台、版本热更新、T3 Connect、Providers 管理、快照还原** | **支持 ✅** | **支持 ✅** |
| **按需休眠 VNC 虚拟桌面 (`/vnc`) + 有头 Chromium + T3 桌面版** | **内置 ✅ (默认休眠 0 内存)** | **物理剥离 ❌ (后台自动隐藏桌面页)** |
| **支持架构** | `linux/amd64` + `linux/arm64` | `linux/amd64` + `linux/arm64` |

---

## 🚀 快速启动

### 方式一：单文件 Docker Compose（推荐）

保存为 `docker-compose.yml` 后执行 `docker compose up -d` 即可启动（无需 `.env`）：

```yaml
services:
  t3code:
    image: ghcr.io/misaka-link/t3code-docker:latest # 无桌面版改为 :headless
    container_name: t3code
    restart: unless-stopped
    init: true
    shm_size: "1gb"
    stop_grace_period: 45s
    ports:
      - "3080:3080"
    environment:
      TZ: "Asia/Shanghai"
      PUID: "1000"
      PGID: "1000"
    volumes:
      - ./data/gateway:/data/gateway
      - ./data/t3:/data/t3
      - ./data/providers:/data/providers
      - ./data/home:/home/coder
      - ./data/snapshots:/data/snapshots
      - ./workspace:/workspace
```

<details>
<summary>📋 展开全参数版 <code>docker-compose.yml</code>（免 <code>.env</code>，列出全部可调项）</summary>

```yaml
services:
  t3code:
    image: ghcr.io/misaka-link/t3code-docker:latest # 无桌面版改为 :headless
    container_name: t3code
    restart: unless-stopped
    init: true
    shm_size: "1gb"
    stop_grace_period: 45s
    ports:
      - "3080:3080"
    environment:
      PROXY_PORT: "3080"                  # 统一对外端口（WebUI / Admin / VNC 共用）
      AUTH_TOKEN: ""                      # 留空首次打开走设密向导；填写则作为初始口令
      SESSION_SECRET: ""                  # 留空自动生成随机签名密钥并持久化
      ADMIN_PATH: "/admin"                # 管理后台路径（登录后可免重启热改）
      VNC_PATH: "/vnc"                    # 虚拟桌面路径（登录后可免重启热改）
      DEFAULT_LOCALE: "zh-CN"             # 默认语言: zh-CN | en-US
      RELEASE_CHANNEL: "stable"           # 更新通道: stable | nightly
      PUID: "1000"                        # coder 用户 UID
      PGID: "1000"                        # coder 用户 GID
      TZ: "Asia/Shanghai"
      T3_PREINSTALL: "core"               # 预装 Agent CLI: core | all | none
      DESKTOP_WIDTH: "1920"               # VNC 默认宽（仅 :latest）
      DESKTOP_HEIGHT: "1080"              # VNC 默认高（仅 :latest）
      DESKTOP_IDLE_MINUTES: "30"          # VNC 空闲自动休眠分钟数（0 禁用）
      TRUST_PROXY: "0"                    # 反代后方设为 "1"
      PUBLIC_URL: ""                      # 公网访问地址，如 https://t3.example.com
      HTTP_PROXY: ""
      HTTPS_PROXY: ""
      ALL_PROXY: ""
      NO_PROXY: "localhost,127.0.0.1,::1"
    security_opt:
      - no-new-privileges:true
    cap_drop: [ALL]
    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, KILL]
    volumes:
      - ./data/gateway:/data/gateway      # 网关凭据与配置 (0700 隔离)
      - ./data/t3:/data/t3                # T3 数据与多版本缓存
      - ./data/providers:/data/providers  # Agent CLI 与 mise 工具链
      - ./data/home:/home/coder           # Agent 登录态 (~/.claude, ~/.codex 等)
      - ./data/snapshots:/data/snapshots  # 快照归档目录
      - ./workspace:/workspace            # 代码研发工作区
```

</details>

### 方式二：克隆仓库部署

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
