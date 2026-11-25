# T3 Code Docker (`t3code-docker`)

专为官方 [T3 Code (`pingdotgg/t3code`)](https://github.com/pingdotgg/t3code) 打造的生产级容器化部署套件与官方同源风格 Web 管理网关。

> 📌 **当前状态**：架构定稿与研发推进中（详见完整架构设计书 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)）

## ✨ 核心特性规划

- **🎨 1:1 官方同源风格安全网关**：单端口（默认 `:3080`）统一承载 T3 Code WebUI、管理控制台（默认 `/admin`，支持热自定义）与按需虚拟桌面（默认 `/vnc`，支持热自定义）；内置首次启动设密向导、防重签幂等配对桥接与多语言界面（默认简体中文）。
- **🔄 官方原版零侵入热更新与回滚**：100% 拒绝源码/压缩包魔改补丁，直接对接官方 `Stable` / `Nightly` 双通道发行包并校验 `SHA256SUMS`；支持升级前自动快照与健康探针失败自动回滚。
- **☁️ 控制台原生管控 T3 Connect**：内置无头设备码（Device-Code）可视化绑定向导、免重登一键开关云隧道、手机实时推送偏好配置与新接入设备审批。
- **🖥️ 按需休眠 VNC 桌面与双端共生**：`:latest` 完整镜像内置默认 `0 内存` 休眠的虚拟桌面、有头 Chromium（完美闭环 `localhost` OAuth 登录与有头浏览器标准 MCP）及 T3 官方桌面客户端（与 WebUI 实时共享同一后端，关闭桌面不断任务）。
- **🛠️ 满血零阉割多语言研发底座**：`:latest`（完整版）与 `:headless`（无桌面版）100% 共享满血编译链、`git`/`gh`、Node LTS、`uv`、`mise`、全彩 Emoji 字体及 T3 原生无头浏览器预览库，原生支持 `linux/amd64` + `linux/arm64` 双架构。
- **🔒 内核级双 UID 权限隔离**：网关控制面（`t3gw`）与 Agent 工作面（`coder`）严格分离，彻底杜绝网关密钥泄露与 `NODE_ENV` / `DISPLAY` / `ELECTRON_RUN_AS_NODE` 全局环境污染。

## 📖 架构与路线图

完整系统拓扑、安全边界、防重签鉴权协议、子系统设计与分阶段实施路线图请查阅：

👉 **[系统架构与工程规划设计书 (`docs/ARCHITECTURE.md`)](docs/ARCHITECTURE.md)**
