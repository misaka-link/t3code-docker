import * as crypto from "node:crypto";
import * as fs from "node:fs";

const [ymlPath, debPath, debFilename] = process.argv.slice(2);
if (!ymlPath || !debPath || !debFilename) {
  throw new Error("Usage: node verify-deb-sha512.mjs <ymlPath> <debPath> <debFilename>");
}

const ymlContent = fs.readFileSync(ymlPath, "utf8");
const escaped = debFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const match = new RegExp(`url:\\s*${escaped}[\\s\\S]*?sha512:\\s*([A-Za-z0-9+/=]+)`).exec(
  ymlContent,
);

if (!match || !match[1]) {
  throw new Error(`Could not find sha512 entry for ${debFilename} in ${ymlPath}`);
}

const expectedSha512 = match[1].trim();
const actualSha512 = crypto
  .createHash("sha512")
  .update(fs.readFileSync(debPath))
  .digest("base64");

if (actualSha512 !== expectedSha512) {
  throw new Error(
    `SHA-512 mismatch for ${debFilename}: expected ${expectedSha512}, got ${actualSha512}`,
  );
}

process.stdout.write(`[verify-deb-sha512] Verified ${debFilename} (${actualSha512.slice(0, 16)}...)\n`);
