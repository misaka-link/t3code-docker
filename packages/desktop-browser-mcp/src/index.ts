#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";

/**
 * Zero-injection standard MCP wrapper for the headed Chromium browser inside the VNC desktop.
 * Automatically wakes `DesktopSupervisor` when hibernated, waits for CDP 127.0.0.1:<port>,
 * refreshes idle activity heartbeats while in use, and delegates MCP stdio to `@playwright/mcp`.
 */
async function wakeDesktopIfNeeded(wakeUrl: string, tokenFile: string): Promise<void> {
  try {
    const token = (await fs.readFile(tokenFile, "utf8")).trim();
    await fetch(wakeUrl, {
      method: "POST",
      headers: {
        "x-t3gw-wake-token": token,
      },
    });
  } catch {
    // Best-effort wake request
  }
}

async function waitForCdpEndpoint(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main(): Promise<void> {
  const wakeUrl = process.env.T3GW_WAKE_URL ?? "http://127.0.0.1:3080/_t3gw/internal/desktop-wake";
  const tokenFile = process.env.T3GW_WAKE_TOKEN_FILE ?? "/data/t3/.desktop-mcp-token";
  const cdpPort = Number(process.env.T3GW_CDP_PORT ?? "9222");

  await wakeDesktopIfNeeded(wakeUrl, tokenFile);
  await waitForCdpEndpoint(cdpPort, 15_000);

  const child = spawn(
    "npx",
    ["-y", "@playwright/mcp@latest", "--cdp-endpoint", `http://127.0.0.1:${cdpPort}`],
    {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    },
  );

  process.stdin.on("data", (chunk: Buffer) => {
    void wakeDesktopIfNeeded(wakeUrl, tokenFile);
    child.stdin.write(chunk);
  });
  process.stdin.on("end", () => {
    child.stdin.end();
  });

  child.stdout.pipe(process.stdout);
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

void main();
