import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  AGENT_PROVIDER_CATALOG,
  MISE_TOOL_CATALOG,
  type GatewayEnv,
  type ProvidersOverview,
  type WorkerEnvConfig,
} from "@t3-docker/shared";
import type { ConfigStore } from "../config/config-store.js";
import type { DesktopSupervisor } from "../desktop/desktop-supervisor.js";
import type { T3ProcessSupervisor } from "../supervisor/t3-supervisor.js";
import { fileExists, writeFileAtomic } from "../utils/atomic-fs.js";
import { runWorkerCommand } from "../utils/cli-runner.js";

export class ProviderToolchainService {
  private busyTask: string | null = null;
  private headlessPlaywrightMcpEnabled = false;
  private readonly desktopWakeTokenPath: string;
  private desktopWakeToken = "";

  public constructor(
    private readonly gatewayEnv: GatewayEnv,
    private readonly configStore: ConfigStore,
    private readonly supervisor: T3ProcessSupervisor,
    private readonly desktopSupervisor?: DesktopSupervisor,
  ) {
    this.desktopWakeTokenPath = path.join(gatewayEnv.T3CODE_HOME, ".desktop-mcp-token");
  }

  public async init(): Promise<void> {
    this.desktopWakeToken = crypto.randomBytes(24).toString("hex");
    await writeFileAtomic(this.desktopWakeTokenPath, `${this.desktopWakeToken}\n`, 0o644).catch(
      () => undefined,
    );
    const wEnv = this.configStore.get().workerEnv;
    await this.syncTelemetrySettings(
      wEnv.disableT3Telemetry,
      wEnv.disableAntigravityTelemetry,
    ).catch(() => undefined);
  }

  public verifyDesktopWakeToken(presented: string | undefined): boolean {
    if (!presented || !this.desktopWakeToken) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(this.desktopWakeToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  public startBackgroundPreinstallIfNeeded(): void {
    if (this.gatewayEnv.T3_PREINSTALL === "none") return;
    const stampPath = path.join(this.gatewayEnv.T3GW_PROVIDERS_DIR, ".preinstall-done");
    void (async () => {
      if (await fileExists(stampPath)) return;
      const targets =
        this.gatewayEnv.T3_PREINSTALL === "all"
          ? AGENT_PROVIDER_CATALOG
          : AGENT_PROVIDER_CATALOG.filter((a) => a.defaultPreinstall);
      for (const item of targets) {
        if (!item.npmPackage) continue;
        await this.mutatePackage({ kind: "agent", id: item.id, action: "install" }).catch(
          () => undefined,
        );
      }
      await writeFileAtomic(stampPath, `${new Date().toISOString()}\n`).catch(() => undefined);
    })();
  }

  public async getOverview(): Promise<ProvidersOverview> {
    const cfg = this.configStore.get();

    const agents = await Promise.all(
      AGENT_PROVIDER_CATALOG.map(async (item) => {
        const version = await this.probeBinaryVersion(item.binary);
        return {
          id: item.id,
          name: item.name,
          binary: item.binary,
          ...(item.npmPackage ? { npmPackage: item.npmPackage } : {}),
          installed: version !== null,
          version,
          installHint: item.installHint,
        };
      }),
    );

    const toolchains = await Promise.all(
      MISE_TOOL_CATALOG.map(async (tool) => {
        const version = await this.probeBinaryVersion(tool.binary);
        return {
          id: tool.id,
          name: tool.name,
          category: tool.category,
          binary: tool.binary,
          installed: version !== null,
          version,
        };
      }),
    );

    return {
      agents,
      toolchains,
      workerEnv: cfg.workerEnv,
      desktopBrowserMcpEnabled: cfg.desktop.enableDesktopBrowserMcp,
      headlessPlaywrightMcpEnabled: this.headlessPlaywrightMcpEnabled,
      busyTask: this.busyTask,
    };
  }

  public async mutatePackage(input: {
    readonly kind: "agent" | "toolchain";
    readonly id: string;
    readonly action: "install" | "upgrade" | "uninstall";
  }): Promise<ProvidersOverview> {
    if (this.busyTask) {
      throw new Error(`Another package task is currently running: ${this.busyTask}`);
    }

    const label = `${input.action}:${input.kind}:${input.id}`;
    this.busyTask = label;
    try {
      if (input.kind === "agent") {
        const item = AGENT_PROVIDER_CATALOG.find((a) => a.id === input.id);
        if (!item?.npmPackage) {
          throw new Error(`Unsupported or non-npm agent package: ${input.id}`);
        }
        const prefix = path.join(this.gatewayEnv.T3GW_PROVIDERS_DIR, "npm-global");
        await fs.mkdir(prefix, { recursive: true });
        const npmArgs =
          input.action === "uninstall"
            ? ["uninstall", "-g", "--prefix", prefix, item.npmPackage]
            : ["install", "-g", "--prefix", prefix, `${item.npmPackage}@latest`];

        const res = await runWorkerCommand({
          command: "npm",
          args: npmArgs,
          gatewayEnv: this.gatewayEnv,
          workerEnv: this.configStore.get().workerEnv,
          timeoutMs: 5 * 60_000,
        });
        if (res.code !== 0) {
          throw new Error(`npm ${input.action} failed: ${res.stderr || res.stdout}`);
        }
      } else {
        const tool = MISE_TOOL_CATALOG.find((t) => t.id === input.id);
        if (!tool) {
          throw new Error(`Unsupported mise toolchain: ${input.id}`);
        }
        const miseArgs =
          input.action === "uninstall"
            ? ["uninstall", tool.miseSpec]
            : ["use", "--global", "--yes", tool.miseSpec];

        const res = await runWorkerCommand({
          command: "mise",
          args: miseArgs,
          gatewayEnv: this.gatewayEnv,
          workerEnv: this.configStore.get().workerEnv,
          timeoutMs: 10 * 60_000,
        });
        if (res.code !== 0) {
          throw new Error(`mise ${input.action} failed: ${res.stderr || res.stdout}`);
        }
      }

      if (this.configStore.get().desktop.enableDesktopBrowserMcp) {
        await this.syncBrowserMcpRegistrations(true, this.headlessPlaywrightMcpEnabled).catch(
          () => undefined,
        );
      }

      return await this.getOverview();
    } finally {
      this.busyTask = null;
    }
  }

  public async updateWorkerEnv(
    workerEnv: WorkerEnvConfig,
    restartServer: boolean,
  ): Promise<ProvidersOverview> {
    const prevEnv = this.configStore.get().workerEnv;
    const telemetryChanged =
      prevEnv.disableT3Telemetry !== workerEnv.disableT3Telemetry ||
      prevEnv.disableAntigravityTelemetry !== workerEnv.disableAntigravityTelemetry;

    await this.configStore.update({ workerEnv });
    await this.syncTelemetrySettings(
      workerEnv.disableT3Telemetry,
      workerEnv.disableAntigravityTelemetry,
    ).catch(() => undefined);

    if (restartServer && this.supervisor.getState() === "healthy") {
      await this.supervisor.restart();
    }
    if (
      telemetryChanged &&
      this.desktopSupervisor?.supported &&
      this.desktopSupervisor.getState() === "running"
    ) {
      await this.desktopSupervisor.restart().catch(() => undefined);
    }
    return this.getOverview();
  }

  /**
   * Synchronizes both T3 Code's Linux managed policy (`/etc/t3code/policy.json`, covering Server,
   * VNC Desktop, and connected WebUI browsers) and Antigravity CLI/ACP feedback survey settings.
   */
  public async syncTelemetrySettings(
    disableT3Telemetry: boolean,
    disableAntigravityTelemetry: boolean,
  ): Promise<void> {
    if (process.platform === "linux") {
      const policyDir = "/etc/t3code";
      const policyFile = "/etc/t3code/policy.json";
      try {
        if (disableT3Telemetry) {
          await fs.mkdir(policyDir, { recursive: true, mode: 0o755 });
          const policyDoc = {
            schemaVersion: 1,
            organization: "T3 Docker Gateway",
            limits: {
              telemetry: false,
            },
          };
          await writeFileAtomic(policyFile, `${JSON.stringify(policyDoc, null, 2)}\n`, 0o644);
        } else if (await fileExists(policyFile)) {
          const existingRaw = await fs.readFile(policyFile, "utf8").catch(() => "");
          if (existingRaw.includes('"T3 Docker Gateway"')) {
            await fs.rm(policyFile, { force: true });
          }
        }
      } catch {
        // Non-root test environments can safely ignore /etc/t3code write errors
      }
    }

    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const disable = process.argv[1] === '1';",
      "const coderHome = process.argv[2];",
      "const t3Home = process.argv[3];",
      "const targets = [path.join(coderHome, '.gemini', 'antigravity-cli', 'settings.json')];",
      "const agyProfilesRoot = path.join(t3Home, 'userdata', 'providers', 'antigravity');",
      "try {",
      "  for (const entry of fs.readdirSync(agyProfilesRoot, { withFileTypes: true })) {",
      "    if (entry.isDirectory()) {",
      "      targets.push(path.join(agyProfilesRoot, entry.name, 'antigravity-cli', 'settings.json'));",
      "    }",
      "  }",
      "} catch {}",
      "for (const file of targets) {",
      "  try {",
      "    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });",
      "    let doc = {};",
      "    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}",
      "    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};",
      "    doc.showFeedbackSurvey = !disable;",
      "    const tmp = file + '.tmp';",
      "    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\\n', { mode: 0o600 });",
      "    fs.renameSync(tmp, file);",
      "  } catch {}",
      "}",
    ].join("\n");

    await runWorkerCommand({
      command: "node",
      args: [
        "-e",
        script,
        disableAntigravityTelemetry ? "1" : "0",
        this.gatewayEnv.CODER_HOME,
        this.gatewayEnv.T3CODE_HOME,
      ],
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      timeoutMs: 5_000,
    }).catch(() => undefined);
  }

  /**
   * Zero-injection standard MCP wiring for both the Headed VNC Desktop Browser (auto-waking CDP)
   * and optional standalone Headless Playwright MCP.
   */
  public async syncBrowserMcpRegistrations(
    enableDesktopBrowserMcp: boolean,
    enableHeadlessPlaywrightMcp: boolean,
  ): Promise<ProvidersOverview> {
    this.headlessPlaywrightMcpEnabled = enableHeadlessPlaywrightMcp;
    const cfg = await this.configStore.update({
      desktop: {
        ...this.configStore.get().desktop,
        enableDesktopBrowserMcp,
      },
    });

    const claudeJsonPath = path.join(this.gatewayEnv.CODER_HOME, ".claude.json");
    let claudeDoc: Record<string, unknown> = {};
    try {
      claudeDoc = JSON.parse(await fs.readFile(claudeJsonPath, "utf8")) as Record<string, unknown>;
    } catch {
      claudeDoc = {};
    }
    const mcpServers =
      claudeDoc.mcpServers && typeof claudeDoc.mcpServers === "object"
        ? { ...(claudeDoc.mcpServers as Record<string, unknown>) }
        : {};

    if (enableDesktopBrowserMcp && this.gatewayEnv.T3GW_VARIANT === "full") {
      mcpServers["t3-desktop-browser"] = {
        command: "node",
        args: ["/opt/t3-gateway/packages/desktop-browser-mcp/dist/index.js"],
        env: {
          T3GW_WAKE_URL: `http://127.0.0.1:${this.gatewayEnv.PROXY_PORT}/_t3gw/internal/desktop-wake`,
          T3GW_WAKE_TOKEN_FILE: this.desktopWakeTokenPath,
          T3GW_CDP_PORT: String(cfg.desktop.cdpPort),
        },
      };
    } else {
      delete mcpServers["t3-desktop-browser"];
    }

    if (enableHeadlessPlaywrightMcp) {
      mcpServers["playwright-headless"] = {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated", "--no-sandbox"],
      };
    } else {
      delete mcpServers["playwright-headless"];
    }

    claudeDoc.mcpServers = mcpServers;
    await writeFileAtomic(claudeJsonPath, `${JSON.stringify(claudeDoc, null, 2)}\n`, 0o600).catch(
      () => undefined,
    );

    return this.getOverview();
  }

  private async probeBinaryVersion(binary: string): Promise<string | null> {
    try {
      const res = await runWorkerCommand({
        command: binary,
        args: ["--version"],
        gatewayEnv: this.gatewayEnv,
        workerEnv: this.configStore.get().workerEnv,
        timeoutMs: 4_000,
      });
      if (res.code !== 0) return null;
      const line = (res.stdout || res.stderr).trim().split(/\r?\n/)[0]?.trim() ?? "";
      const semver = /(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/.exec(line);
      return semver?.[1] ?? (line.slice(0, 32) || "installed");
    } catch {
      return null;
    }
  }
}
