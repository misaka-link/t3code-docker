import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as tar from "tar";
import type {
  GatewayEnv,
  ReleaseChannel,
  ReleaseItem,
  VersionsOverview,
} from "@t3-docker/shared";
import type { ConfigStore } from "../config/config-store.js";
import type { DesktopSupervisor } from "../desktop/desktop-supervisor.js";
import type { SnapshotService } from "../snapshots/snapshot-service.js";
import type { T3ProcessSupervisor } from "../supervisor/t3-supervisor.js";
import { fileExists, writeFileAtomic } from "../utils/atomic-fs.js";
import { getFreeDiskMb, runWorkerCommand } from "../utils/cli-runner.js";

interface GithubReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly browser_download_url: string;
}

interface GithubReleasePayload {
  readonly tag_name: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
  readonly published_at: string;
  readonly body?: string;
  readonly assets?: readonly GithubReleaseAsset[];
}

const RELEASE_CACHE_TTL_MS = 10 * 60_000;

export function parseSha256Sums(content: string, assetFilename: string): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (match && match[2]?.trim() === assetFilename) {
      return match[1]!.toLowerCase();
    }
  }
  return null;
}

export function resolveExpectedAssetName(
  version: string,
  variant: "full" | "headless",
  arch: string,
): string {
  const normArch = arch === "arm64" ? "arm64" : "x64";
  if (variant === "full") {
    const debArch = normArch === "arm64" ? "arm64" : "amd64";
    return `T3-Code-${version}-${debArch}.deb`;
  }
  return `t3-${version}-linux-${normArch}.tar.gz`;
}

export class VersionHubService {
  private readonly versionsDir: string;
  private readonly currentLinkPath: string;
  private cachedReleases: { fetchedAt: number; etag?: string; data: GithubReleasePayload[] } | null =
    null;
  private switching = false;
  private lastOperationError: string | null = null;

  public constructor(
    private readonly gatewayEnv: GatewayEnv,
    private readonly configStore: ConfigStore,
    private readonly supervisor: T3ProcessSupervisor,
    private readonly snapshotService: SnapshotService,
    private readonly desktopSupervisor?: DesktopSupervisor,
  ) {
    this.versionsDir = path.join(gatewayEnv.T3CODE_HOME, "runtime", "versions");
    this.currentLinkPath = path.join(gatewayEnv.T3CODE_HOME, "runtime", "current");
  }

  public async getOverview(forceRefresh = false): Promise<VersionsOverview> {
    const cfg = this.configStore.get();
    const channel = cfg.releaseChannel;
    const activeVersion =
      (await this.readCurrentLinkedVersion()) ?? (await this.supervisor.detectInstalledVersion());
    const installedVersions = await this.listInstalledVersions(activeVersion);
    const installedSet = new Set(installedVersions.map((v) => v.version));

    const releases = await this.fetchRemoteReleases(forceRefresh).catch(() => []);
    const remoteReleases: ReleaseItem[] = [];

    for (const rel of releases) {
      if (rel.draft) continue;
      const version = rel.tag_name.replace(/^v/, "");
      if (version.includes("-preview.")) continue;
      const isNightly = version.includes("-nightly.");
      const itemChannel: ReleaseChannel = isNightly ? "nightly" : "stable";
      if (itemChannel !== channel) continue;

      const expectedAsset = resolveExpectedAssetName(
        version,
        this.gatewayEnv.T3GW_VARIANT,
        process.arch,
      );
      const asset = rel.assets?.find((a) => a.name === expectedAsset);

      remoteReleases.push({
        version,
        tagName: rel.tag_name,
        channel: itemChannel,
        publishedAt: rel.published_at,
        notesSummary: (rel.body ?? "").slice(0, 1500),
        assetName: asset?.name ?? expectedAsset,
        assetSizeMb: asset ? Math.round((asset.size / (1024 * 1024)) * 10) / 10 : null,
        installed: installedSet.has(version),
        active: activeVersion === version,
      });

      if (remoteReleases.length >= 15) break;
    }

    const newestRemote = remoteReleases[0]?.version ?? null;
    const updateAvailable =
      newestRemote && newestRemote !== activeVersion ? newestRemote : null;

    return {
      channel,
      activeVersion,
      installedVersions,
      remoteReleases,
      updateAvailable,
      switching: this.switching,
      lastOperationError: this.lastOperationError,
    };
  }

  /**
   * Downloads (if not cached), verifies SHA-256, creates a pre-switch snapshot,
   * atomically flips `runtime/current`, and rolls back automatically if the health probe fails.
   */
  public async installAndSwitchVersion(input: {
    readonly version: string;
    readonly createSnapshotBeforeSwitch: boolean;
  }): Promise<VersionsOverview> {
    if (this.switching) {
      throw new Error("Another version switch operation is already in progress.");
    }
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?$/.test(input.version)) {
      throw new Error(`Invalid version identifier: ${input.version}`);
    }

    this.switching = true;
    this.lastOperationError = null;

    try {
      const targetDir = path.join(this.versionsDir, input.version);
      const markerPath = path.join(targetDir, ".install-complete");
      const alreadyInstalled =
        (await fileExists(markerPath)) &&
        (await fs.readFile(markerPath, "utf8")).trim() === input.version;

      if (!alreadyInstalled) {
        const freeMb = await getFreeDiskMb(this.gatewayEnv.T3CODE_HOME);
        if (freeMb !== null && freeMb < this.gatewayEnv.VERSIONS_MIN_FREE_MB) {
          throw new Error(
            `Insufficient free disk space: ${freeMb} MB available, need at least ${this.gatewayEnv.VERSIONS_MIN_FREE_MB} MB.`,
          );
        }
        await this.downloadAndStageVersion(input.version, targetDir);
      }

      if (input.createSnapshotBeforeSwitch) {
        await this.snapshotService
          .createSnapshot({
            scope: "config",
            note: `auto-pre-switch-to-${input.version}`,
          })
          .catch(() => undefined);
      }

      await this.activateVersionWithRollback(input.version, targetDir);
      return await this.getOverview(false);
    } catch (err) {
      this.lastOperationError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.switching = false;
    }
  }

  public async removeInstalledVersion(version: string): Promise<VersionsOverview> {
    const active = await this.readCurrentLinkedVersion();
    if (active === version) {
      throw new Error("Cannot delete the currently active version.");
    }
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?$/.test(version)) {
      throw new Error("Invalid version name");
    }
    const dir = path.join(this.versionsDir, version);
    await fs.rm(dir, { recursive: true, force: true });
    return this.getOverview(false);
  }

  public async activateVersionWithRollback(
    targetVersion: string,
    targetDir: string,
    healthTimeoutMs = 30_000,
  ): Promise<void> {
    const previousTarget = await this.readSymlinkRaw(this.currentLinkPath);
    const previousVersion = await this.readCurrentLinkedVersion();

    let switchedOk = false;
    await this.supervisor.runInMaintenance(
      "updating",
      async () => {
        if (this.desktopSupervisor?.supported && this.desktopSupervisor.getState() === "running") {
          await this.desktopSupervisor.stop().catch(() => undefined);
        }
        await this.replaceSymlinkAtomic(this.currentLinkPath, targetDir);
        this.supervisor.setActiveVersionHint(targetVersion);
      },
      true,
    );

    switchedOk = await this.supervisor.waitForHealthy(healthTimeoutMs);

    if (!switchedOk) {
      this.supervisor.logs.push(
        "system",
        `[versions] Version ${targetVersion} failed health probe! Rolling back to ${previousVersion ?? "previous runtime"}...`,
      );
      if (previousTarget) {
        await this.supervisor.runInMaintenance(
          "updating",
          async () => {
            await this.replaceSymlinkAtomic(this.currentLinkPath, previousTarget);
            this.supervisor.setActiveVersionHint(previousVersion);
          },
          true,
        );
        await this.supervisor.waitForHealthy(20_000);
      }
      throw new Error(
        `Version ${targetVersion} failed readiness health check within ${Math.round(healthTimeoutMs / 1000)}s and was automatically rolled back.`,
      );
    }
  }

  private async downloadAndStageVersion(version: string, targetDir: string): Promise<void> {
    const baseUrl = (
      this.configStore.get().releaseBaseUrl || "https://github.com/pingdotgg/t3code/releases/download"
    ).replace(/\/$/, "");
    const assetName = resolveExpectedAssetName(
      version,
      this.gatewayEnv.T3GW_VARIANT,
      process.arch,
    );

    const stagingRoot = path.join(this.gatewayEnv.T3CODE_HOME, ".staging");
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.mkdir(this.versionsDir, { recursive: true });
    const stageDir = path.join(
      stagingRoot,
      `ver-${version}-${crypto.randomBytes(4).toString("hex")}`,
    );
    await fs.mkdir(stageDir, { recursive: true });

    try {
      const sumsRes = await fetch(`${baseUrl}/v${version}/SHA256SUMS`);
      if (!sumsRes.ok) {
        throw new Error(`Failed to fetch SHA256SUMS (HTTP ${sumsRes.status})`);
      }
      const sumsText = await sumsRes.text();
      const expectedSha = parseSha256Sums(sumsText, assetName);
      if (!expectedSha) {
        throw new Error(`Asset ${assetName} not found in release v${version} SHA256SUMS`);
      }

      const archivePath = path.join(stageDir, assetName);
      const assetRes = await fetch(`${baseUrl}/v${version}/${assetName}`);
      if (!assetRes.ok) {
        throw new Error(`Failed to download ${assetName} (HTTP ${assetRes.status})`);
      }
      const arrayBuf = await assetRes.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      const actualSha = crypto.createHash("sha256").update(buf).digest("hex");
      if (actualSha !== expectedSha) {
        throw new Error(
          `SHA-256 mismatch for ${assetName}: expected ${expectedSha}, got ${actualSha}`,
        );
      }
      await fs.writeFile(archivePath, buf);

      const unpackDir = path.join(stageDir, "unpacked");
      await fs.mkdir(unpackDir, { recursive: true });

      if (assetName.endsWith(".deb")) {
        const res = await runWorkerCommand({
          command: "dpkg-deb",
          args: ["-x", archivePath, unpackDir],
          gatewayEnv: this.gatewayEnv,
          workerEnv: this.configStore.get().workerEnv,
          timeoutMs: 120_000,
        });
        if (res.code !== 0) {
          throw new Error(`dpkg-deb extraction failed: ${res.stderr}`);
        }
        await this.createCleanDesktopServerLauncher(unpackDir);
      } else {
        await tar.x({
          file: archivePath,
          cwd: unpackDir,
          strip: 1,
        });
      }

      await writeFileAtomic(path.join(unpackDir, ".install-complete"), `${version}\n`);
      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.rename(unpackDir, targetDir);
    } finally {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Creates a clean `t3-server-launcher` inside an unpacked `.deb` slot that runs the bundled
   * `server.asar` while immediately deleting `ELECTRON_RUN_AS_NODE` inside a bootstrapper
   * so child shells in `/workspace` never inherit it.
   */
  private async createCleanDesktopServerLauncher(unpackedRoot: string): Promise<void> {
    const appFolderCandidates = [
      path.join(unpackedRoot, "opt", "T3 Code"),
      path.join(unpackedRoot, "opt", "T3 Code (Nightly)"),
    ];
    let appDir: string | null = null;
    let exeName = "t3-code";
    for (const dir of appFolderCandidates) {
      if (await fileExists(path.join(dir, "t3-code"))) {
        appDir = dir;
        exeName = "t3-code";
        break;
      }
      if (await fileExists(path.join(dir, "t3-code-nightly"))) {
        appDir = dir;
        exeName = "t3-code-nightly";
        break;
      }
    }
    if (!appDir) return;

    const bootstrapMjs = path.join(unpackedRoot, "bootstrap-t3-server.mjs");
    const serverEntryCandidates = [
      path.join(appDir, "resources", "app.asar", "apps", "server", "dist", "bin.mjs"),
      path.join(appDir, "resources", "server.asar", "apps", "server", "dist", "bin.mjs"),
    ];

    const bootstrapContent = `// Scrubs Electron Node-mode env vars before loading T3 Server so Agent terminals stay 100% clean.
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.T3CODE_DESKTOP_CLI_LAUNCHER;
import { pathToFileURL } from "node:url";
import fs from "node:fs";
const candidates = ${JSON.stringify(serverEntryCandidates)};
const entry = candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
await import(pathToFileURL(entry).href);
`;
    await writeFileAtomic(bootstrapMjs, bootstrapContent, 0o644);

    const launcherPath = path.join(unpackedRoot, "t3-server-launcher");
    const exeFull = path.join(appDir, exeName);
    const launcherSh = `#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec "${exeFull}" "${bootstrapMjs}" "$@"
`;
    await writeFileAtomic(launcherPath, launcherSh, 0o755);
  }

  private async listInstalledVersions(activeVersion: string | null) {
    try {
      const entries = await fs.readdir(this.versionsDir, { withFileTypes: true });
      const results: Array<{
        version: string;
        installedAt: string;
        sizeMb: number;
        active: boolean;
      }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const verDir = path.join(this.versionsDir, entry.name);
        const marker = path.join(verDir, ".install-complete");
        if (!(await fileExists(marker))) continue;
        const stat = await fs.stat(marker);
        const sizeBytes = await this.estimateDirSize(verDir, 2);
        results.push({
          version: entry.name,
          installedAt: stat.mtime.toISOString(),
          sizeMb: Math.max(1, Math.round(sizeBytes / (1024 * 1024))),
          active: entry.name === activeVersion,
        });
      }
      return results.sort((a, b) => b.installedAt.localeCompare(a.installedAt));
    } catch {
      return [];
    }
  }

  private async estimateDirSize(dir: string, depth: number): Promise<number> {
    if (depth < 0) return 0;
    let total = 0;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isFile()) {
          const st = await fs.stat(full);
          total += st.size;
        } else if (e.isDirectory()) {
          total += await this.estimateDirSize(full, depth - 1);
        }
      }
    } catch {
      // Ignore
    }
    return total;
  }

  private async readCurrentLinkedVersion(): Promise<string | null> {
    const target = await this.readSymlinkRaw(this.currentLinkPath);
    if (!target) return null;
    return path.basename(target);
  }

  private async readSymlinkRaw(linkPath: string): Promise<string | null> {
    try {
      return await fs.readlink(linkPath);
    } catch {
      return null;
    }
  }

  private async replaceSymlinkAtomic(linkPath: string, targetPath: string): Promise<void> {
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    const tmpLink = `${linkPath}.tmp.${process.pid}`;
    await fs.rm(tmpLink, { force: true }).catch(() => undefined);
    await fs.symlink(targetPath, tmpLink, process.platform === "win32" ? "junction" : "dir");
    await fs.rename(tmpLink, linkPath);
  }

  private async fetchRemoteReleases(forceRefresh: boolean): Promise<GithubReleasePayload[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cachedReleases &&
      now - this.cachedReleases.fetchedAt < RELEASE_CACHE_TTL_MS
    ) {
      return this.cachedReleases.data;
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "t3code-docker-gateway",
    };
    if (!forceRefresh && this.cachedReleases?.etag) {
      headers["If-None-Match"] = this.cachedReleases.etag;
    }

    const res = await fetch("https://api.github.com/repos/pingdotgg/t3code/releases?per_page=30", {
      headers,
    });
    if (res.status === 304 && this.cachedReleases) {
      this.cachedReleases.fetchedAt = now;
      return this.cachedReleases.data;
    }
    if (!res.ok) {
      if (this.cachedReleases) return this.cachedReleases.data;
      throw new Error(`GitHub Releases API returned HTTP ${res.status}`);
    }

    const data = (await res.json()) as GithubReleasePayload[];
    const etag = res.headers.get("etag") ?? undefined;
    this.cachedReleases = {
      fetchedAt: now,
      ...(etag ? { etag } : {}),
      data,
    };
    return data;
  }
}
