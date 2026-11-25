// Scrubs Electron Node-mode environment variables immediately before loading T3 Server
// so child shells, Playwright, and user Electron projects in /workspace remain 100% unpolluted.
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.T3CODE_DESKTOP_CLI_LAUNCHER;

import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

const targetPath = process.env.T3_SERVER_ENTRY_MJS;
if (!targetPath || !fs.existsSync(targetPath)) {
  process.stderr.write(`[bootstrap-t3-server] Server entry not found: ${targetPath ?? "unset"}\n`);
  process.exit(1);
}

await import(pathToFileURL(targetPath).href);
