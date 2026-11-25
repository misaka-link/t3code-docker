import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import * as tar from "tar";
import type {
  GatewayEnv,
  ReleaseChannel,
  ReleaseItem,
  VersionSwitchPhase,
  VersionSwitchProgress,
  VersionsOverview,
} from "@t3-docker/shared";
import type { ConfigStore } from "../config/config-store.js";
import type { DesktopSupervisor } from "../desktop/desktop-supervisor.js";
import { mergeNoProxy } from "../security/env-sanitizer.js";
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
const VERSION_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.]+)?$/;
const MIN_FORWARD_PROGRESS_BYTES = 64 * 1024;
const MAX_CONSECUTIVE_STALLS = 6;
const MAX_RESUME_SEGMENTS = 64;

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

export function parseElectronBuilderSha512(
  ymlContent: string,
  assetFilename: string,
): string | null {
  const escaped = assetFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`url:\\s*${escaped}[\\s\\S]*?sha512:\\s*([A-Za-z0-9+/=]+)`);
  const match = regex.exec(ymlContent);
  return match?.[1]?.trim() ?? null;
}

export function parseElectronBuilderSize(
  ymlContent: string,
  assetFilename: string,
): number | null {
  const escaped = assetFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`url:\\s*${escaped}[\\s\\S]*?size:\\s*(\\d+)`);
  const match = regex.exec(ymlContent);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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

export function formatTransferError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [err.message];
  let cursor: unknown = (err as Error & { cause?: unknown }).cause;
  let depth = 0;
  while (cursor && depth < 3) {
    depth += 1;
    if (cursor instanceof Error) {
      const code = (cursor as Error & { code?: string }).code;
      const detail = code ? `${code}: ${cursor.message}` : cursor.message;
      if (detail && !parts.includes(detail)) {
        parts.push(detail);
      }
      cursor = (cursor as Error & { cause?: unknown }).cause;
    } else if (typeof cursor === "string") {
      if (!parts.includes(cursor)) parts.push(cursor);
      break;
    } else {
      break;
    }
  }
  if (parts[0] === "terminated" && parts.length > 1) {
    return `Network stream interrupted (${parts.slice(1).join(" -> ")})`;
  }
  if (parts[0] === "terminated") {
    return "Network download stream was prematurely closed by the remote server or proxy (terminated).";
  }
  return parts.join(" — ");
}

function roundMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

async function computeFileHash(
  filePath: string,
  algorithm: "sha256" | "sha512",
  encoding: "hex" | "base64",
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fsSync.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest(encoding)));
  });
}

export interface ResumableDownloadOptions {
  readonly url: string;
  readonly destPath: string;
  readonly expectedSizeBytes?: number | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly chunkTimeoutMs?: number;
  readonly preferCurl?: boolean;
  readonly onProgress?: (info: {
    readonly downloadedBytes: number;
    readonly totalBytes: number | null;
    readonly attempt: number;
  }) => void;
  readonly onRetry?: (info: {
    readonly downloadedBytes: number;
    readonly totalBytes: number | null;
    readonly attempt: number;
    readonly reason: string;
  }) => void;
}

/**
 * Downloads a large archive directly to disk with automatic HTTP `Range` (`206 Partial Content`)
 * resume across mid-stream TCP resets, CDN stalls, or cross-border connection drops.
 */
export async function downloadArchiveResumable(opts: ResumableDownloadOptions): Promise<void> {
  const partPath = `${opts.destPath}.part`;
  await fs.rm(partPath, { force: true }).catch(() => undefined);

  let totalBytes: number | null = opts.expectedSizeBytes ?? null;
  let consecutiveStalls = 0;
  let attempt = 0;
  let lastReason = "unknown network error";
  const useCurl = opts.preferCurl ?? process.platform === "linux";

  while (attempt < MAX_RESUME_SEGMENTS) {
    attempt += 1;
    let beforeBytes = (await fs.stat(partPath).catch(() => null))?.size ?? 0;

    if (totalBytes !== null && beforeBytes === totalBytes && totalBytes > 0) {
      await fs.rename(partPath, opts.destPath);
      return;
    }
    if (totalBytes !== null && beforeBytes > totalBytes) {
      await fs.rm(partPath, { force: true }).catch(() => undefined);
      beforeBytes = 0;
    }

    opts.onProgress?.({ downloadedBytes: beforeBytes, totalBytes, attempt });

    const outcome = useCurl
      ? await runSingleCurlSegment({
          url: opts.url,
          partPath,
          resumeFrom: beforeBytes,
          totalBytes,
          ...(opts.env ? { env: opts.env } : {}),
          ...(opts.onProgress ? { onProgress: (dl, tot) => opts.onProgress?.({ downloadedBytes: dl, totalBytes: tot, attempt }) } : {}),
        })
      : await runSingleFetchSegment({
          url: opts.url,
          partPath,
          resumeFrom: beforeBytes,
          totalBytes,
          chunkTimeoutMs: opts.chunkTimeoutMs ?? 25_000,
          ...(opts.onProgress ? { onProgress: (dl, tot) => opts.onProgress?.({ downloadedBytes: dl, totalBytes: tot, attempt }) } : {}),
        });

    if (outcome.discoveredTotalBytes && !totalBytes) {
      totalBytes = outcome.discoveredTotalBytes;
    }

    if (outcome.fatalHttpStatus) {
      await fs.rm(partPath, { force: true }).catch(() => undefined);
      throw new Error(
        `Failed to download ${path.basename(opts.destPath)} (HTTP ${outcome.fatalHttpStatus})`,
      );
    }

    if (outcome.resetRange) {
      await fs.rm(partPath, { force: true }).catch(() => undefined);
      beforeBytes = 0;
    }

    const afterBytes = (await fs.stat(partPath).catch(() => null))?.size ?? 0;
    opts.onProgress?.({ downloadedBytes: afterBytes, totalBytes, attempt });

    if (
      outcome.ok &&
      afterBytes > 0 &&
      (totalBytes === null || afterBytes === totalBytes)
    ) {
      await fs.rename(partPath, opts.destPath);
      return;
    }

    lastReason =
      outcome.error ??
      (totalBytes !== null && afterBytes !== totalBytes
        ? `incomplete body (${roundMb(afterBytes)} / ${roundMb(totalBytes)} MB)`
        : "stream closed prematurely");

    if (afterBytes >= beforeBytes + MIN_FORWARD_PROGRESS_BYTES) {
      consecutiveStalls = 0;
    } else {
      consecutiveStalls += 1;
      if (consecutiveStalls >= MAX_CONSECUTIVE_STALLS) {
        const progressHint =
          totalBytes !== null
            ? `${roundMb(afterBytes)} / ${roundMb(totalBytes)} MB`
            : `${roundMb(afterBytes)} MB`;
        throw new Error(
          `Download of ${path.basename(opts.destPath)} failed at ${progressHint} after ${attempt} attempts (${lastReason}). Check container network to GitHub Releases or configure HTTPS_PROXY / release mirror URL.`,
        );
      }
    }

    opts.onRetry?.({
      downloadedBytes: afterBytes,
      totalBytes,
      attempt: attempt + 1,
      reason: lastReason,
    });

    const backoffMs = Math.min(4000, 800 * Math.max(1, consecutiveStalls));
    await new Promise((r) => setTimeout(r, backoffMs));
  }

  throw new Error(
    `Download of ${path.basename(opts.destPath)} exceeded maximum resume segments (${MAX_RESUME_SEGMENTS}): ${lastReason}`,
  );
}

interface SegmentOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly fatalHttpStatus?: number;
  readonly resetRange?: boolean;
  readonly discoveredTotalBytes?: number | null;
}

async function runSingleCurlSegment(params: {
  readonly url: string;
  readonly partPath: string;
  readonly resumeFrom: number;
  readonly totalBytes: number | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
}): Promise<SegmentOutcome> {
  return new Promise((resolve) => {
    const args = [
      "-fsSL",
      "--connect-timeout",
      "20",
      "--speed-time",
      "25",
      "--speed-limit",
      "8192",
      ...(params.resumeFrom > 0 ? ["-C", String(params.resumeFrom)] : []),
      "-w",
      "%{http_code}",
      "-o",
      params.partPath,
      params.url,
    ];

    const child = spawn("curl", args, {
      env: params.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      if (stderr.length < 4096) stderr += d;
    });

    const pollTimer = setInterval(() => {
      fs.stat(params.partPath)
        .then((st) => params.onProgress?.(st.size, params.totalBytes))
        .catch(() => undefined);
    }, 400);

    const maxSegmentTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 20 * 60_000);

    child.once("error", (err) => {
      clearInterval(pollTimer);
      clearTimeout(maxSegmentTimer);
      resolve({ ok: false, error: formatTransferError(err) });
    });

    child.once("close", (code) => {
      clearInterval(pollTimer);
      clearTimeout(maxSegmentTimer);
      const httpCode = Number.parseInt(stdout.trim().slice(-3), 10);
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      if (httpCode === 404 || httpCode === 403 || httpCode === 401 || httpCode === 410) {
        resolve({ ok: false, fatalHttpStatus: httpCode });
        return;
      }
      if (code === 33 || httpCode === 416) {
        resolve({
          ok: false,
          resetRange: true,
          error: "server rejected HTTP Range; restarting cleanly",
        });
        return;
      }
      const cleanErr = stderr.trim().replace(/^curl:\s*/, "") || `curl exit ${code ?? -1}`;
      resolve({ ok: false, error: cleanErr });
    });
  });
}

async function runSingleFetchSegment(params: {
  readonly url: string;
  readonly partPath: string;
  readonly resumeFrom: number;
  readonly totalBytes: number | null;
  readonly chunkTimeoutMs: number;
  readonly onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
}): Promise<SegmentOutcome> {
  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      controller.abort(new Error(`stream stalled for ${Math.round(params.chunkTimeoutMs / 1000)}s`));
    }, params.chunkTimeoutMs);
  };

  try {
    resetStallTimer();
    const headers: Record<string, string> = {
      "User-Agent": "t3code-docker-gateway",
    };
    if (params.resumeFrom > 0) {
      headers["Range"] = `bytes=${params.resumeFrom}-`;
    }

    const res = await fetch(params.url, {
      headers,
      signal: controller.signal,
    });

    if (res.status === 416) {
      return { ok: false, resetRange: true, error: "HTTP 416 Range Not Satisfiable" };
    }
    if (res.status === 404 || res.status === 403 || res.status === 401 || res.status === 410) {
      return { ok: false, fatalHttpStatus: res.status };
    }
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    if (!res.body) {
      return { ok: false, error: "empty response body" };
    }

    const isPartial = res.status === 206 && params.resumeFrom > 0;
    let discoveredTotal: number | null = params.totalBytes;
    const contentRange = res.headers.get("content-range");
    if (contentRange) {
      const m = /\/(\d+)$/.exec(contentRange.trim());
      if (m?.[1]) discoveredTotal = Number.parseInt(m[1], 10);
    } else {
      const cl = res.headers.get("content-length");
      if (cl && !isPartial) {
        const parsed = Number.parseInt(cl, 10);
        if (Number.isFinite(parsed) && parsed > 0) discoveredTotal = parsed;
      }
    }

    let writtenBytes = isPartial ? params.resumeFrom : 0;
    const fileStream = fsSync.createWriteStream(params.partPath, {
      flags: isPartial ? "a" : "w",
      mode: 0o644,
    });

    const nodeReadable = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    await new Promise<void>((resolve, reject) => {
      nodeReadable.on("data", (chunk: Buffer) => {
        resetStallTimer();
        writtenBytes += chunk.length;
        params.onProgress?.(writtenBytes, discoveredTotal);
      });
      nodeReadable.once("error", reject);
      fileStream.once("error", reject);
      fileStream.once("finish", () => resolve());
      nodeReadable.pipe(fileStream);
    });

    return { ok: true, discoveredTotalBytes: discoveredTotal };
  } catch (err) {
    return { ok: false, error: formatTransferError(err) };
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
}

export class VersionHubService {
  private readonly versionsDir: string;
  private readonly currentLinkPath: string;
  private cachedReleases: { fetchedAt: number; etag?: string; data: GithubReleasePayload[] } | null =
    null;
  private switching = false;
  private switchProgress: VersionSwitchProgress | null = null;
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
        assetSizeMb: asset ? roundMb(asset.size) : null,
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
      switchProgress: this.switchProgress,
      lastOperationError: this.lastOperationError,
    };
  }

  /**
   * Starts a non-blocking background version download & hot-switch task so browser requests
   * behind Nginx / OpenResty / Cloudflare reverse proxies never hit 60s/100s gateway timeouts.
   */
  public async startInstallAndSwitchVersion(input: {
    readonly version: string;
    readonly createSnapshotBeforeSwitch: boolean;
  }): Promise<VersionsOverview> {
    this.prepareSwitchLock(input.version);
    void this.executeSwitchPipeline(input).catch(() => undefined);
    return this.getOverview(false);
  }

  /**
   * Downloads (if not cached), verifies cryptographic checksum, creates a pre-switch snapshot,
   * atomically flips `runtime/current`, and rolls back automatically if the health probe fails.
   */
  public async installAndSwitchVersion(input: {
    readonly version: string;
    readonly createSnapshotBeforeSwitch: boolean;
  }): Promise<VersionsOverview> {
    this.prepareSwitchLock(input.version);
    await this.executeSwitchPipeline(input);
    return this.getOverview(false);
  }

  private prepareSwitchLock(version: string): void {
    if (this.switching) {
      const err = new Error("Another version switch operation is already in progress.") as Error & {
        statusCode?: number;
      };
      err.statusCode = 409;
      throw err;
    }
    if (!VERSION_REGEX.test(version)) {
      const err = new Error(`Invalid version identifier: ${version}`) as Error & {
        statusCode?: number;
      };
      err.statusCode = 400;
      throw err;
    }

    const knownSizeBytes = this.lookupCachedAssetSizeBytes(version);
    this.switching = true;
    this.lastOperationError = null;
    this.switchProgress = {
      targetVersion: version,
      phase: "downloading",
      percent: 0,
      downloadedMb: 0,
      totalMb: knownSizeBytes ? roundMb(knownSizeBytes) : null,
      attempt: 1,
    };
  }

  private updateProgress(
    targetVersion: string,
    phase: VersionSwitchPhase,
    patch?: Partial<Omit<VersionSwitchProgress, "targetVersion" | "phase">>,
  ): void {
    const prev = this.switchProgress;
    this.switchProgress = {
      targetVersion,
      phase,
      percent: patch?.percent !== undefined ? patch.percent : (prev?.percent ?? null),
      downloadedMb:
        patch?.downloadedMb !== undefined ? patch.downloadedMb : (prev?.downloadedMb ?? null),
      totalMb: patch?.totalMb !== undefined ? patch.totalMb : (prev?.totalMb ?? null),
      attempt: patch?.attempt ?? prev?.attempt ?? 1,
    };
  }

  private async executeSwitchPipeline(input: {
    readonly version: string;
    readonly createSnapshotBeforeSwitch: boolean;
  }): Promise<void> {
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
        this.updateProgress(input.version, "snapshotting", { percent: null });
        await this.snapshotService
          .createSnapshot({
            scope: "config",
            note: `auto-pre-switch-to-${input.version}`,
          })
          .catch(() => undefined);
      }

      this.updateProgress(input.version, "activating", { percent: null });
      await this.activateVersionWithRollback(input.version, targetDir, 45_000);
      this.supervisor.logs.push(
        "system",
        `[versions] Successfully switched active T3 Code runtime to v${input.version}.`,
      );
    } catch (err) {
      const formatted = formatTransferError(err);
      this.lastOperationError = formatted;
      this.supervisor.logs.push(
        "system",
        `[versions] Version switch to v${input.version} failed: ${formatted}`,
      );
      throw new Error(formatted);
    } finally {
      this.switching = false;
      this.switchProgress = null;
    }
  }

  public async removeInstalledVersion(version: string): Promise<VersionsOverview> {
    const active = await this.readCurrentLinkedVersion();
    if (active === version) {
      throw new Error("Cannot delete the currently active version.");
    }
    if (!VERSION_REGEX.test(version)) {
      throw new Error("Invalid version name");
    }
    const dir = path.join(this.versionsDir, version);
    await fs.rm(dir, { recursive: true, force: true });
    return this.getOverview(false);
  }

  public async activateVersionWithRollback(
    targetVersion: string,
    targetDir: string,
    healthTimeoutMs = 45_000,
  ): Promise<void> {
    const previousTarget = await this.readSymlinkRaw(this.currentLinkPath);
    const previousVersion = await this.readCurrentLinkedVersion();
    const wasDesktopRunning =
      Boolean(this.desktopSupervisor?.supported) &&
      this.desktopSupervisor?.getState() === "running";

    let switchedOk = false;
    await this.supervisor.runInMaintenance(
      "updating",
      async () => {
        if (wasDesktopRunning) {
          await this.desktopSupervisor?.stop().catch(() => undefined);
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
      if (wasDesktopRunning) {
        await this.desktopSupervisor?.start().catch(() => undefined);
      }
      throw new Error(
        `Version ${targetVersion} failed readiness health check within ${Math.round(healthTimeoutMs / 1000)}s and was automatically rolled back.`,
      );
    }

    if (wasDesktopRunning) {
      await this.desktopSupervisor?.start().catch(() => undefined);
    }
  }

  private lookupCachedAssetSizeBytes(version: string): number | null {
    if (!this.cachedReleases) return null;
    const assetName = resolveExpectedAssetName(
      version,
      this.gatewayEnv.T3GW_VARIANT,
      process.arch,
    );
    const rel = this.cachedReleases.data.find(
      (r) => r.tag_name.replace(/^v/, "") === version,
    );
    const asset = rel?.assets?.find((a) => a.name === assetName);
    return asset?.size ?? null;
  }

  private buildOutboundTransferEnv(): NodeJS.ProcessEnv {
    const workerEnv = this.configStore.get().workerEnv;
    const httpProxy = workerEnv.httpProxy || process.env.HTTP_PROXY || process.env.http_proxy;
    const httpsProxy =
      workerEnv.httpsProxy ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      httpProxy;
    const noProxy = mergeNoProxy(workerEnv.noProxy || process.env.NO_PROXY || process.env.no_proxy);

    return {
      PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: "/tmp",
      LANG: "C.UTF-8",
      ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
      ...(process.env.SSL_CERT_DIR ? { SSL_CERT_DIR: process.env.SSL_CERT_DIR } : {}),
      ...(process.env.CURL_CA_BUNDLE ? { CURL_CA_BUNDLE: process.env.CURL_CA_BUNDLE } : {}),
      ...(process.env.NODE_EXTRA_CA_CERTS
        ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
        : {}),
      ...(httpProxy ? { HTTP_PROXY: httpProxy, http_proxy: httpProxy } : {}),
      ...(httpsProxy ? { HTTPS_PROXY: httpsProxy, https_proxy: httpsProxy } : {}),
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    };
  }

  private hasConfiguredOutboundProxy(): boolean {
    const workerEnv = this.configStore.get().workerEnv;
    return Boolean(
      workerEnv.httpProxy ||
        workerEnv.httpsProxy ||
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY,
    );
  }

  private async fetchTextResilient(
    url: string,
    extraHeaders?: Record<string, string>,
  ): Promise<string> {
    let lastErr: unknown = null;

    if (!(process.platform === "linux" && this.hasConfiguredOutboundProxy())) {
      for (let i = 0; i < 3; i += 1) {
        try {
          const res = await fetch(url, {
            headers: {
              "User-Agent": "t3code-docker-gateway",
              ...(extraHeaders ?? {}),
            },
            signal: AbortSignal.timeout(25_000),
          });
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return await res.text();
        } catch (err) {
          lastErr = err;
          if (err instanceof Error && /^HTTP 4\d\d$/.test(err.message)) {
            break;
          }
          await new Promise((r) => setTimeout(r, 600 * (i + 1)));
        }
      }
    }

    if (process.platform === "linux") {
      return await this.fetchTextViaCurl(url, extraHeaders);
    }

    throw new Error(`Failed to fetch ${url}: ${formatTransferError(lastErr)}`);
  }

  private async fetchTextViaCurl(
    url: string,
    extraHeaders?: Record<string, string>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const headerArgs: string[] = [];
      for (const [k, v] of Object.entries(extraHeaders ?? {})) {
        headerArgs.push("-H", `${k}: ${v}`);
      }
      const args = [
        "-fsSL",
        "--connect-timeout",
        "15",
        "--max-time",
        "45",
        "--retry",
        "2",
        "--retry-delay",
        "1",
        "-H",
        "User-Agent: t3code-docker-gateway",
        ...headerArgs,
        url,
      ];
      const child = spawn("curl", args, {
        env: this.buildOutboundTransferEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        stdout += d;
      });
      child.stderr.on("data", (d: string) => {
        if (stderr.length < 4096) stderr += d;
      });
      child.once("error", (err) => reject(err));
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `curl exit ${code ?? -1}`));
      });
    });
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
      // 1. Fetch lightweight checksum manifest FIRST (fails fast & discovers exact byte size)
      let expectedSha512: string | null = null;
      let expectedSha256: string | null = null;
      let expectedSizeBytes: number | null = this.lookupCachedAssetSizeBytes(version);

      if (assetName.endsWith(".deb")) {
        const ymlPrefix = version.includes("-nightly.") ? "nightly" : "latest";
        const ymlName =
          process.arch === "arm64" ? `${ymlPrefix}-linux-arm64.yml` : `${ymlPrefix}-linux.yml`;
        const ymlText = await this.fetchTextResilient(`${baseUrl}/v${version}/${ymlName}`);
        expectedSha512 = parseElectronBuilderSha512(ymlText, assetName);
        if (!expectedSha512) {
          throw new Error(`Asset ${assetName} not found in release v${version} ${ymlName}`);
        }
        const ymlSize = parseElectronBuilderSize(ymlText, assetName);
        if (ymlSize) expectedSizeBytes = ymlSize;
      } else {
        const sumsText = await this.fetchTextResilient(`${baseUrl}/v${version}/SHA256SUMS`);
        expectedSha256 = parseSha256Sums(sumsText, assetName);
        if (!expectedSha256) {
          throw new Error(`Asset ${assetName} not found in release v${version} SHA256SUMS`);
        }
      }

      // 2. Stream archive directly to disk with automatic HTTP Range resume
      const archivePath = path.join(stageDir, assetName);
      const assetUrl = `${baseUrl}/v${version}/${assetName}`;
      this.supervisor.logs.push(
        "system",
        `[versions] Downloading ${assetName}${expectedSizeBytes ? ` (${roundMb(expectedSizeBytes)} MB)` : ""}...`,
      );
      this.updateProgress(version, "downloading", {
        downloadedMb: 0,
        totalMb: expectedSizeBytes ? roundMb(expectedSizeBytes) : null,
        percent: 0,
        attempt: 1,
      });

      await downloadArchiveResumable({
        url: assetUrl,
        destPath: archivePath,
        expectedSizeBytes,
        env: this.buildOutboundTransferEnv(),
        onProgress: ({ downloadedBytes, totalBytes, attempt }) => {
          const pct =
            totalBytes && totalBytes > 0
              ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
              : null;
          this.updateProgress(version, "downloading", {
            downloadedMb: roundMb(downloadedBytes),
            totalMb: totalBytes ? roundMb(totalBytes) : null,
            percent: pct,
            attempt,
          });
        },
        onRetry: ({ downloadedBytes, totalBytes, attempt, reason }) => {
          this.supervisor.logs.push(
            "system",
            `[versions] Download interrupted at ${roundMb(downloadedBytes)}${totalBytes ? ` / ${roundMb(totalBytes)}` : ""} MB (${reason}); resuming via HTTP Range (attempt #${attempt})...`,
          );
          this.updateProgress(version, "downloading", { attempt });
        },
      });

      // 3. Stream cryptographic checksum verification from disk (zero memory spike)
      this.updateProgress(version, "verifying", { percent: 100 });
      if (expectedSha512) {
        const actualSha512 = await computeFileHash(archivePath, "sha512", "base64");
        if (actualSha512 !== expectedSha512) {
          throw new Error(
            `SHA-512 mismatch for ${assetName}: expected ${expectedSha512}, got ${actualSha512}`,
          );
        }
      } else if (expectedSha256) {
        const actualSha256 = await computeFileHash(archivePath, "sha256", "hex");
        if (actualSha256 !== expectedSha256) {
          throw new Error(
            `SHA-256 mismatch for ${assetName}: expected ${expectedSha256}, got ${actualSha256}`,
          );
        }
      }

      // 4. Unpack into isolated slot directory
      this.updateProgress(version, "extracting", { percent: null });
      const unpackDir = path.join(stageDir, "unpacked");
      await fs.mkdir(unpackDir, { recursive: true });
      await this.chownToCoderIfRoot(stageDir);

      if (assetName.endsWith(".deb")) {
        const res = await runWorkerCommand({
          command: "dpkg-deb",
          args: ["-x", archivePath, unpackDir],
          gatewayEnv: this.gatewayEnv,
          workerEnv: this.configStore.get().workerEnv,
          timeoutMs: 300_000,
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
      await this.chownToCoderIfRoot(unpackDir);
      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.rename(unpackDir, targetDir);
    } finally {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async chownToCoderIfRoot(targetPath: string): Promise<void> {
    const coderUser = this.gatewayEnv.CODER_USER;
    if (
      process.platform !== "linux" ||
      !coderUser ||
      typeof process.getuid !== "function" ||
      process.getuid() !== 0
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      const child = spawn("chown", ["-R", `${coderUser}:${coderUser}`, targetPath], {
        stdio: "ignore",
      });
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
  }

  /**
   * Creates a clean `t3-server-launcher` inside an unpacked `.deb` slot matching T3's official
   * `DesktopCliShim.ts` (`direct` mode) across all channels (`T3 Code (Beta)`, `T3 Code (Nightly)`, `T3 Code`).
   */
  private async createCleanDesktopServerLauncher(unpackedRoot: string): Promise<void> {
    const optRoot = path.join(unpackedRoot, "opt");
    let appDir: string | null = null;
    let exeName = "t3code";

    const entries = await fs.readdir(optRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(optRoot, entry.name);
      for (const candidateExe of ["t3code", "t3-code", "t3-code-nightly"]) {
        if (await fileExists(path.join(dir, candidateExe))) {
          appDir = dir;
          exeName = candidateExe;
          break;
        }
      }
      if (appDir) break;
    }
    if (!appDir) {
      throw new Error("Unpacked .deb does not contain an executable under opt/*");
    }

    const hasServerAsar = await fileExists(path.join(appDir, "resources", "server.asar"));
    const asarName = hasServerAsar ? "server.asar" : "app.asar";
    const relApp = path.posix.join("opt", path.basename(appDir));
    const relExe = path.posix.join(relApp, exeName);
    const relEntry = path.posix.join(relApp, "resources", asarName, "apps/server/dist/bin.mjs");

    const launcherPath = path.join(unpackedRoot, "t3-server-launcher");
    const launcherSh = [
      "#!/bin/sh",
      'slot_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      'export T3CODE_CLI_PATH="${slot_dir}/t3-server-launcher"',
      "export ELECTRON_RUN_AS_NODE=1",
      `exec "\${slot_dir}/${relExe}" "\${slot_dir}/${relEntry}" "$@"`,
      "",
    ].join("\n");
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

    const url = "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=30";

    if (!(process.platform === "linux" && this.hasConfiguredOutboundProxy())) {
      try {
        const headers: Record<string, string> = {
          Accept: "application/vnd.github+json",
          "User-Agent": "t3code-docker-gateway",
        };
        if (!forceRefresh && this.cachedReleases?.etag) {
          headers["If-None-Match"] = this.cachedReleases.etag;
        }
        const res = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 304 && this.cachedReleases) {
          this.cachedReleases.fetchedAt = now;
          return this.cachedReleases.data;
        }
        if (res.ok) {
          const data = (await res.json()) as GithubReleasePayload[];
          const etag = res.headers.get("etag") ?? undefined;
          this.cachedReleases = {
            fetchedAt: now,
            ...(etag ? { etag } : {}),
            data,
          };
          return data;
        }
      } catch {
        // Fall through to curl fallback on Linux
      }
    }

    if (process.platform === "linux") {
      try {
        const raw = await this.fetchTextViaCurl(url, {
          Accept: "application/vnd.github+json",
        });
        const data = JSON.parse(raw) as GithubReleasePayload[];
        this.cachedReleases = { fetchedAt: now, data };
        return data;
      } catch (err) {
        if (this.cachedReleases) return this.cachedReleases.data;
        throw err;
      }
    }

    if (this.cachedReleases) return this.cachedReleases.data;
    throw new Error("Failed to fetch GitHub Releases metadata");
  }
}
