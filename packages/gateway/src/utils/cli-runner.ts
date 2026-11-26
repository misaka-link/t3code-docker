import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GatewayEnv, WorkerEnvConfig } from "@t3-docker/shared";
import { buildCleanWorkerEnv } from "../security/env-sanitizer.js";
import { fileExists, writeFileAtomic } from "./atomic-fs.js";

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function buildT3CliBinShim(t3HomeDir: string): string {
  const escapedHome = t3HomeDir.replace(/'/g, "'\\''");
  return [
    "#!/bin/sh",
    "# Managed by T3 Docker Gateway: dynamically delegates to active runtime/current slot.",
    `default_home='${escapedHome}'`,
    'home="${T3CODE_HOME:-$default_home}"',
    'export T3CODE_HOME="$home"',
    'if [ -x "$home/runtime/current/t3" ]; then',
    '  export T3CODE_CLI_PATH="$home/bin/t3"',
    '  exec "$home/runtime/current/t3" "$@"',
    "fi",
    'if [ -x "$home/runtime/current/t3-server-launcher" ]; then',
    '  exec "$home/runtime/current/t3-server-launcher" "$@"',
    "fi",
    'echo "Active T3 Code runtime not found under $home/runtime/current" >&2',
    "exit 127",
    "",
  ].join("\n");
}

/**
 * Ensures `$T3CODE_HOME/bin/t3` always delegates to `$T3CODE_HOME/runtime/current`
 * rather than a hardcoded `runtime/versions/<oldVer>` path written by T3 Desktop's shim.
 */
export async function syncT3CliBinShim(
  gatewayEnv: GatewayEnv,
  workerEnv: WorkerEnvConfig,
): Promise<string> {
  const binDir = path.join(gatewayEnv.T3CODE_HOME, "bin");
  const shimPath = path.join(binDir, "t3");
  const content = buildT3CliBinShim(gatewayEnv.T3CODE_HOME);

  if (
    process.platform === "linux" &&
    gatewayEnv.CODER_USER &&
    typeof process.getuid === "function" &&
    process.getuid() === 0
  ) {
    await runWorkerCommand({
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs'),path=require('node:path'),p=process.argv[1],body=process.argv[2];fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o755});const tmp=p+'.tmp.'+process.pid;fs.writeFileSync(tmp,body,{mode:0o755});fs.chmodSync(tmp,0o755);fs.renameSync(tmp,p);",
        shimPath,
        content,
      ],
      gatewayEnv,
      workerEnv,
      cwd: "/tmp",
      timeoutMs: 5_000,
    });
    return shimPath;
  }

  await fs.mkdir(binDir, { recursive: true, mode: 0o755 });
  await writeFileAtomic(shimPath, content, 0o755);
  return shimPath;
}

export async function resolveT3Binary(gatewayEnv: GatewayEnv): Promise<string> {
  if (gatewayEnv.T3_BIN_PATH) {
    return gatewayEnv.T3_BIN_PATH;
  }
  const currentRuntimeBin = path.join(gatewayEnv.T3CODE_HOME, "runtime", "current", "t3");
  if (await fileExists(currentRuntimeBin)) {
    return currentRuntimeBin;
  }
  const currentDesktopWrapper = path.join(
    gatewayEnv.T3CODE_HOME,
    "runtime",
    "current",
    "t3-server-launcher",
  );
  if (await fileExists(currentDesktopWrapper)) {
    return currentDesktopWrapper;
  }
  return "t3";
}

export function wrapPrivilegeDrop(
  command: string,
  args: readonly string[],
  coderUser: string,
): { cmd: string; args: string[] } {
  if (
    process.platform === "linux" &&
    coderUser &&
    typeof process.getuid === "function" &&
    process.getuid() === 0
  ) {
    return {
      cmd: "gosu",
      args: [coderUser, command, ...args],
    };
  }
  return { cmd: command, args: [...args] };
}

export async function runWorkerCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly gatewayEnv: GatewayEnv;
  readonly workerEnv: WorkerEnvConfig;
  readonly cwd?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}): Promise<CommandResult> {
  const cleanEnv = buildCleanWorkerEnv({
    gatewayEnv: input.gatewayEnv,
    workerEnv: input.workerEnv,
    ...(input.extraEnv ? { extraEnv: input.extraEnv } : {}),
  });
  const wrapped = wrapPrivilegeDrop(input.command, input.args, input.gatewayEnv.CODER_USER);
  const timeoutMs = input.timeoutMs ?? 30_000;

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(wrapped.cmd, wrapped.args, {
      cwd: input.cwd ?? input.gatewayEnv.T3_WORKSPACE,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${input.command}`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        });
      }
    });
  });
}

/**
 * Extracts a trailing JSON object or array from CLI stdout that may contain leading banner text.
 */
export function parseJsonFromCliStdout<T = unknown>(stdout: string): T | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const lines = trimmed.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const firstChar = lines[i]?.trimStart()[0];
      if (firstChar === "{" || firstChar === "[") {
        const candidate = lines.slice(i).join("\n");
        try {
          return JSON.parse(candidate) as T;
        } catch {
          // Try next line
        }
      }
    }
    return null;
  }
}

export async function getFreeDiskMb(targetDir: string): Promise<number | null> {
  try {
    await fs.mkdir(targetDir, { recursive: true });
    const stats = await fs.statfs(targetDir);
    return Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}
