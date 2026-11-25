# T3 Code Docker (`t3code-docker`)

专为官方 [T3 Code (`pingdotgg/t3code`)](https://github.com/pingdotgg/t3code) 打造的**生产级容器化套件与 1:1 官方同源风格 Web 安全网关**。

全仓采用 **100% TypeScript (`strict: true`) + Fastify + React 19 + Tailwind CSS v4** 构建，坚持**零侵入官方原版产物（Zero Monkey-Patching）**、**双镜像满血研发底座零阉割**与**内核级双 UID 安全隔离**。

---

## ✨ 核心亮点

- **🎨 1:1 复刻 T3 官方 WebUI 质感（默认简体中文）**：单端口（默认 `:3080`）统一承载 T3 Code 官方 WebUI（`/`）、管理控制台（默认 `/admin`，支持免重启热自定义）与按需虚拟桌面（默认 `/vnc`，支持热自定义）；内置编译期强类型中英双语切换与深浅色主题。
- **🔐 前置安全门禁与「零重复签发」无感桥接**：首次访问自动进入初始化设密向导（`scrypt` 哈希 + IP 防爆破限流）；`T3AuthBridge` 通过原生 `t3_session_*` Cookie 检测、Singleflight 并发互斥锁与持久化桌面会话对账，实现**输一次网关密码直进 WebUI 且绝不堆积重复会话**。
- **🔄 官方原版零补丁热更新与自动回滚**：支持 `Stable` / `Nightly` 双通道在线检测、校验官方 `SHA256SUMS`、升级前自动快照、多版本缓存秒级切换；新版若未通过 30s 健康探针自动回滚上一正常版本。
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

### 方式一：Docker Compose（推荐）

```bash
git clone https://github.com/misaka-link/t3code-docker.git
cd t3code-docker
cp .env.example .env

# 启动默认完整版（含按需休眠 VNC 桌面与有头浏览器）
docker compose up -d

# 或启动无桌面满血研发版
docker compose -f docker-compose.headless.yml up -d
```

### 方式二：单行 `docker run`

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

## ⚙️ 常见环境变量

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PROXY_PORT` | `3080` | 单一统一对外端口（WebUI、Admin 与 VNC 共用） |
| `AUTH_TOKEN` | *(留空)* | 初始访问口令；留空则首次打开网页进入可视化设密向导 |
| `ADMIN_PATH` | `/admin` | 管理控制台路径（支持后台免重启热修改） |
| `VNC_PATH` | `/vnc` | 虚拟桌面路径（支持后台免重启热修改） |
| `PUID` / `PGID` | `1000` / `1000` | 工作平面 `coder` 用户 UID/GID，保持宿主机 `/workspace` 属主干净 |
| `T3_PREINSTALL` | `core` | 首次启动自动安装至持久化卷的 Agent CLI（`core` / `all` / `none`） |
| `TRUST_PROXY` | `0` | 部署于可信反向代理后方时设为 `1` |
| `PUBLIC_URL` | *(空)* | 外部访问基准 URL（用于生成外部扫码配对链接与 Origin 校验） |
| `HTTP_PROXY` / `HTTPS_PROXY` | *(空)* | 工作平面出站网络代理 |

---

## 🛠️ 本地开发与测试

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

更多底层安全边界、防重签协议状态机与模块设计请查阅：**[系统架构与工程规划设计书 (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md)**。
