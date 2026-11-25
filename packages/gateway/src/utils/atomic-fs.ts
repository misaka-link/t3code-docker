import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ZodType, ZodTypeDef } from "zod";

/**
 * Writes content to a sibling temporary file on the SAME filesystem, fsyncs,
 * applies file permissions, and atomically renames over the target path.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  mode = 0o644,
): Promise<void> {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  const suffix = `${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = path.join(dir, `.${path.basename(resolved)}.${suffix}`);

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, "w", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") {
      await fs.chmod(tmpPath, mode);
    }
    await fs.rename(tmpPath, resolved);
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readJsonWithSchema<TOutput>(
  filePath: string,
  schema: ZodType<TOutput, ZodTypeDef, unknown>,
): Promise<TOutput | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return schema.parse(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
