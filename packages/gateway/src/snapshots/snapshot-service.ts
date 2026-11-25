import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as tar from "tar";
import { z } from "zod";
import {
  SUITE_VERSION,
  SnapshotScopeEnum,
  type GatewayEnv,
  type SnapshotItem,
  type SnapshotScope,
} from "@t3-docker/shared";
import type { ConfigStore } from "../config/config-store.js";
import type { DesktopSupervisor } from "../desktop/desktop-supervisor.js";
import type { T3ProcessSupervisor } from "../supervisor/t3-supervisor.js";
import { fileExists, writeFileAtomic } from "../utils/atomic-fs.js";
import { runWorkerCommand } from "../utils/cli-runner.js";

const MAX_ARCHIVE_ENTRIES = 500_000;
const MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB

const SnapshotManifestSchema = z.object({
  formatVersion: z.literal(1),
  id: z.string().min(1),
  scope: SnapshotScopeEnum,
  note: z.string(),
  createdAt: z.string(),
  suiteVersion: z.string(),
  t3Version: z.string().nullable(),
});
type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export function isUnsafeArchiveEntryPath(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return true;
  }
  const segments = normalized.split("/");
  return segments.some((seg) => seg === "..");
}

export class SnapshotService {
  private readonly snapshotsDir: string;
  private mutex: Promise<void> = Promise.resolve();

  public constructor(
    private readonly gatewayEnv: GatewayEnv,
    private readonly configStore: ConfigStore,
    private readonly supervisor: T3ProcessSupervisor,
    private readonly desktopSupervisor?: DesktopSupervisor,
  ) {
    this.snapshotsDir = gatewayEnv.T3GW_SNAPSHOTS_DIR;
  }

  public async listSnapshots(): Promise<SnapshotItem[]> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
    const entries = await fs.readdir(this.snapshotsDir, { withFileTypes: true });
    const items: SnapshotItem[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".meta.json")) continue;
      const metaPath = path.join(this.snapshotsDir, entry.name);
      try {
        const raw = JSON.parse(await fs.readFile(metaPath, "utf8")) as SnapshotItem;
        const archivePath = path.join(this.snapshotsDir, raw.filename);
        if (await fileExists(archivePath)) {
          items.push(raw);
        }
      } catch {
        // Ignore malformed sidecar file
      }
    }

    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  public async createSnapshot(input: {
    readonly scope: SnapshotScope;
    readonly note?: string;
  }): Promise<SnapshotItem> {
    return this.withMutex(async () => {
      await fs.mkdir(this.snapshotsDir, { recursive: true });
      const stagingBase = path.join(this.gatewayEnv.T3CODE_HOME, ".staging");
      await fs.mkdir(stagingBase, { recursive: true });

      const id = `snap-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
      const stageDir = path.join(stagingBase, id);
      const archiveFilename = `${id}.tar.gz`;
      const tempArchivePath = path.join(stagingBase, archiveFilename);
      const finalArchivePath = path.join(this.snapshotsDir, archiveFilename);

      try {
        await fs.mkdir(path.join(stageDir, "gateway"), { recursive: true });
        await fs.mkdir(path.join(stageDir, "userdata"), { recursive: true });

        const gwCfgPath = path.join(this.gatewayEnv.T3GW_DATA_DIR, "gateway.config.json");
        if (await fileExists(gwCfgPath)) {
          await fs.copyFile(gwCfgPath, path.join(stageDir, "gateway", "gateway.config.json"));
        }

        const userdataSrc = path.join(this.gatewayEnv.T3CODE_HOME, "userdata");
        if (await fileExists(userdataSrc)) {
          await this.stageUserdata(userdataSrc, path.join(stageDir, "userdata"), input.scope);
        }

        const status = await this.supervisor.getStatus();
        const manifest: SnapshotManifest = {
          formatVersion: 1,
          id,
          scope: input.scope,
          note: input.note?.trim() ?? "",
          createdAt: new Date().toISOString(),
          suiteVersion: SUITE_VERSION,
          t3Version: status.activeVersion,
        };
        await writeFileAtomic(
          path.join(stageDir, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );

        await tar.c(
          {
            gzip: true,
            file: tempArchivePath,
            cwd: stageDir,
            portable: true,
          },
          ["manifest.json", "gateway", "userdata"],
        );

        const sha256 = await this.computeFileSha256(tempArchivePath);
        const stat = await fs.stat(tempArchivePath);
        await fs.rename(tempArchivePath, finalArchivePath).catch(async () => {
          await fs.copyFile(tempArchivePath, finalArchivePath);
          await fs.rm(tempArchivePath, { force: true });
        });

        const item: SnapshotItem = {
          id,
          filename: archiveFilename,
          scope: input.scope,
          note: manifest.note,
          createdAt: manifest.createdAt,
          sizeBytes: stat.size,
          suiteVersion: manifest.suiteVersion,
          t3Version: manifest.t3Version,
          sha256,
        };
        await writeFileAtomic(
          path.join(this.snapshotsDir, `${id}.meta.json`),
          `${JSON.stringify(item, null, 2)}\n`,
        );
        return item;
      } finally {
        await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(tempArchivePath, { force: true }).catch(() => undefined);
      }
    });
  }

  public async validateArchive(archivePath: string): Promise<SnapshotManifest> {
    let entryCount = 0;
    let totalBytes = 0;
    let unsafeFound: string | null = null;
    let manifestRaw = "";

    await tar.t({
      file: archivePath,
      onReadEntry: (entry) => {
        entryCount += 1;
        totalBytes += entry.size ?? 0;
        if (
          isUnsafeArchiveEntryPath(entry.path) ||
          entry.type === "SymbolicLink" ||
          entry.type === "Link"
        ) {
          unsafeFound = entry.path;
        }
        if (entry.path === "manifest.json" || entry.path === "./manifest.json") {
          const chunks: Buffer[] = [];
          entry.on("data", (c: Buffer) => chunks.push(c));
          entry.on("end", () => {
            manifestRaw = Buffer.concat(chunks).toString("utf8");
          });
        }
      },
    });

    if (unsafeFound) {
      throw new Error(`Unsafe archive entry rejected: ${unsafeFound}`);
    }
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Archive exceeds maximum entry limit (${MAX_ARCHIVE_ENTRIES})`);
    }
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("Archive exceeds maximum uncompressed size limit");
    }
    if (!manifestRaw) {
      throw new Error("Archive is missing manifest.json");
    }

    return SnapshotManifestSchema.parse(JSON.parse(manifestRaw));
  }

  public async restoreSnapshot(id: string, restoreScope: SnapshotScope): Promise<void> {
    return this.withMutex(async () => {
      const items = await this.listSnapshots();
      const target = items.find((item) => item.id === id);
      if (!target) {
        throw new Error(`Snapshot not found: ${id}`);
      }
      if (restoreScope === "full" && target.scope === "config") {
        throw new Error("Cannot perform a full database restore from a config-only snapshot.");
      }

      const archivePath = path.join(this.snapshotsDir, target.filename);
      const actualSha = await this.computeFileSha256(archivePath);
      if (actualSha !== target.sha256) {
        throw new Error("Snapshot SHA-256 checksum mismatch; refusing to restore corrupted archive.");
      }
      await this.validateArchive(archivePath);

      const stagingBase = path.join(this.gatewayEnv.T3CODE_HOME, ".staging");
      const unpackDir = path.join(stagingBase, `restore-${Date.now()}`);
      await fs.mkdir(unpackDir, { recursive: true });

      try {
        await tar.x({
          file: archivePath,
          cwd: unpackDir,
        });

        await this.supervisor.runInMaintenance("maintenance", async () => {
          if (this.desktopSupervisor?.supported && this.desktopSupervisor.getState() === "running") {
            await this.desktopSupervisor.stop().catch(() => undefined);
          }

          const unpackedGwCfg = path.join(unpackDir, "gateway", "gateway.config.json");
          if (await fileExists(unpackedGwCfg)) {
            const rawCfg = JSON.parse(await fs.readFile(unpackedGwCfg, "utf8")) as Record<
              string,
              unknown
            >;
            await this.configStore.update(rawCfg);
          }

          const unpackedUserdata = path.join(unpackDir, "userdata");
          const liveUserdata = path.join(this.gatewayEnv.T3CODE_HOME, "userdata");
          await fs.mkdir(liveUserdata, { recursive: true });

          if (await fileExists(unpackedUserdata)) {
            await this.applyRestoredUserdata(unpackedUserdata, liveUserdata, restoreScope);
          }
        });
      } finally {
        await fs.rm(unpackDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  public async importSnapshot(sourceBuffer: Buffer, originalName?: string): Promise<SnapshotItem> {
    return this.withMutex(async () => {
      await fs.mkdir(this.snapshotsDir, { recursive: true });
      const stagingBase = path.join(this.gatewayEnv.T3CODE_HOME, ".staging");
      await fs.mkdir(stagingBase, { recursive: true });
      const tmpFile = path.join(
        stagingBase,
        `import-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.tar.gz`,
      );

      try {
        await fs.writeFile(tmpFile, sourceBuffer);
        const manifest = await this.validateArchive(tmpFile);
        const sha256 = await this.computeFileSha256(tmpFile);
        const stat = await fs.stat(tmpFile);

        const newId = `snap-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
        const filename = `${newId}.tar.gz`;
        const finalPath = path.join(this.snapshotsDir, filename);
        await fs.rename(tmpFile, finalPath).catch(async () => {
          await fs.copyFile(tmpFile, finalPath);
          await fs.rm(tmpFile, { force: true });
        });

        const item: SnapshotItem = {
          id: newId,
          filename,
          scope: manifest.scope,
          note: manifest.note || originalName || "Imported snapshot",
          createdAt: manifest.createdAt,
          sizeBytes: stat.size,
          suiteVersion: manifest.suiteVersion,
          t3Version: manifest.t3Version,
          sha256,
        };
        await writeFileAtomic(
          path.join(this.snapshotsDir, `${newId}.meta.json`),
          `${JSON.stringify(item, null, 2)}\n`,
        );
        return item;
      } finally {
        await fs.rm(tmpFile, { force: true }).catch(() => undefined);
      }
    });
  }

  public async deleteSnapshot(id: string): Promise<boolean> {
    const metaPath = path.join(this.snapshotsDir, `${id}.meta.json`);
    const archivePath = path.join(this.snapshotsDir, `${id}.tar.gz`);
    const existed = await fileExists(metaPath);
    await fs.rm(metaPath, { force: true }).catch(() => undefined);
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
    return existed;
  }

  public async resolveExportPath(id: string): Promise<string | null> {
    const items = await this.listSnapshots();
    const found = items.find((i) => i.id === id);
    if (!found) return null;
    const p = path.join(this.snapshotsDir, found.filename);
    return (await fileExists(p)) ? p : null;
  }

  private async stageUserdata(srcDir: string, destDir: string, scope: SnapshotScope): Promise<void> {
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "tools" || entry.name === "logs" || entry.name === "browser-artifacts") {
        continue;
      }
      const isSqlite = entry.name.includes(".sqlite");
      if (scope === "config" && isSqlite) continue;
      if (entry.name.endsWith("-wal") || entry.name.endsWith("-shm")) continue;

      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isFile() && isSqlite) {
        await this.backupSqliteConsistent(srcPath, destPath);
      } else if (entry.isFile()) {
        await fs.copyFile(srcPath, destPath);
      } else if (entry.isDirectory()) {
        await fs.cp(srcPath, destPath, { recursive: true, dereference: false });
      }
    }
  }

  private async applyRestoredUserdata(
    unpackedDir: string,
    liveDir: string,
    scope: SnapshotScope,
  ): Promise<void> {
    if (scope === "full") {
      const liveEntries = await fs.readdir(liveDir);
      for (const name of liveEntries) {
        if (name.includes(".sqlite")) {
          await fs.rm(path.join(liveDir, name), { force: true });
        }
      }
    }

    const entries = await fs.readdir(unpackedDir, { withFileTypes: true });
    for (const entry of entries) {
      const isSqlite = entry.name.includes(".sqlite");
      if (scope === "config" && isSqlite) continue;
      const src = path.join(unpackedDir, entry.name);
      const dst = path.join(liveDir, entry.name);
      if (entry.isFile()) {
        const buf = await fs.readFile(src);
        await writeFileAtomic(dst, buf);
      } else if (entry.isDirectory()) {
        await fs.rm(dst, { recursive: true, force: true });
        await fs.cp(src, dst, { recursive: true });
      }
    }
  }

  private async backupSqliteConsistent(srcDb: string, destDb: string): Promise<void> {
    const res = await runWorkerCommand({
      command: "sqlite3",
      args: [srcDb, `.backup '${destDb.replace(/'/g, "''")}'`],
      gatewayEnv: this.gatewayEnv,
      workerEnv: this.configStore.get().workerEnv,
      timeoutMs: 60_000,
    }).catch(() => ({ code: 1, stdout: "", stderr: "" }));

    if (res.code !== 0 || !(await fileExists(destDb))) {
      await fs.copyFile(srcDb, destDb);
    }
  }

  private async computeFileSha256(filePath: string): Promise<string> {
    const buf = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  private async withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
