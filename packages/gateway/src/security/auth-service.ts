import * as crypto from "node:crypto";
import * as path from "node:path";
import * as net from "node:net";
import { z } from "zod";
import { readJsonWithSchema, writeFileAtomic } from "../utils/atomic-fs.js";

export const GATEWAY_SESSION_COOKIE = "t3gw_session";
const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 days

const StoredCredentialsSchema = z.object({
  saltHex: z.string().min(16),
  hashHex: z.string().min(32),
  sessionSecretHex: z.string().min(64),
  sessionEpoch: z.number().int().nonnegative().default(1),
  updatedAt: z.string(),
});
type StoredCredentials = z.infer<typeof StoredCredentialsSchema>;

export interface VerifiedGatewaySession {
  readonly sessionId: string;
  readonly epoch: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface RateBucket {
  failures: number[];
  lockedUntil: number;
}

export class GatewayAuthService {
  private readonly credentialsPath: string;
  private credentials: StoredCredentials | null = null;
  private fallbackSessionSecretHex: string = crypto.randomBytes(32).toString("hex");
  private readonly rateBuckets = new Map<string, RateBucket>();

  public constructor(
    dataDir: string,
    private readonly maxFailures = 8,
    private readonly windowMs = 5 * 60_000,
    private readonly lockoutMs = 5 * 60_000,
  ) {
    this.credentialsPath = path.join(dataDir, "credentials.json");
  }

  public async init(secrets?: {
    readonly initialAuthToken?: string;
    readonly initialSessionSecret?: string;
  }): Promise<void> {
    if (secrets?.initialSessionSecret) {
      this.fallbackSessionSecretHex = crypto
        .createHash("sha256")
        .update(secrets.initialSessionSecret)
        .digest("hex");
    }

    const existing = await readJsonWithSchema(this.credentialsPath, StoredCredentialsSchema).catch(
      () => null,
    );
    if (existing) {
      this.credentials = existing;
    }

    if (secrets?.initialAuthToken) {
      await this.setPassword(secrets.initialAuthToken, false);
    }
  }

  public isSetupRequired(): boolean {
    return this.credentials === null;
  }

  public async setPassword(plainPassword: string, bumpEpoch: boolean): Promise<void> {
    const salt = crypto.randomBytes(16);
    const derived = await this.deriveScrypt(plainPassword, salt);
    const nextEpoch = bumpEpoch ? (this.credentials?.sessionEpoch ?? 1) + 1 : (this.credentials?.sessionEpoch ?? 1);
    const sessionSecretHex =
      this.credentials?.sessionSecretHex ?? this.fallbackSessionSecretHex;

    const next: StoredCredentials = {
      saltHex: salt.toString("hex"),
      hashHex: derived.toString("hex"),
      sessionSecretHex,
      sessionEpoch: nextEpoch,
      updatedAt: new Date().toISOString(),
    };
    this.credentials = next;
    await writeFileAtomic(this.credentialsPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  }

  public async verifyPassword(plainPassword: string): Promise<boolean> {
    if (!this.credentials) return false;
    const salt = Buffer.from(this.credentials.saltHex, "hex");
    const expected = Buffer.from(this.credentials.hashHex, "hex");
    const actual = await this.deriveScrypt(plainPassword, salt);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  }

  public issueSessionToken(): { token: string; session: VerifiedGatewaySession; maxAgeSeconds: number } {
    const epoch = this.credentials?.sessionEpoch ?? 1;
    const secret = this.credentials?.sessionSecretHex ?? this.fallbackSessionSecretHex;
    const now = Math.floor(Date.now() / 1000);
    const session: VerifiedGatewaySession = {
      sessionId: crypto.randomBytes(16).toString("hex"),
      epoch,
      issuedAt: now,
      expiresAt: now + SESSION_TTL_SECONDS,
    };
    const payloadB64 = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
    const sigB64 = crypto
      .createHmac("sha256", Buffer.from(secret, "hex"))
      .update(payloadB64)
      .digest("base64url");
    return {
      token: `${payloadB64}.${sigB64}`,
      session,
      maxAgeSeconds: SESSION_TTL_SECONDS,
    };
  }

  public verifySessionToken(rawToken: string | undefined): VerifiedGatewaySession | null {
    if (!rawToken || !this.credentials) return null;
    const dotIndex = rawToken.indexOf(".");
    if (dotIndex <= 0) return null;
    const payloadB64 = rawToken.slice(0, dotIndex);
    const sigB64 = rawToken.slice(dotIndex + 1);

    const expectedSig = crypto
      .createHmac("sha256", Buffer.from(this.credentials.sessionSecretHex, "hex"))
      .update(payloadB64)
      .digest();
    let actualSig: Buffer;
    try {
      actualSig = Buffer.from(sigB64, "base64url");
    } catch {
      return null;
    }
    if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(actualSig, expectedSig)) {
      return null;
    }

    try {
      const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as VerifiedGatewaySession;
      const now = Math.floor(Date.now() / 1000);
      if (parsed.epoch !== this.credentials.sessionEpoch) return null;
      if (typeof parsed.expiresAt !== "number" || parsed.expiresAt <= now) return null;
      if (typeof parsed.sessionId !== "string" || parsed.sessionId.length < 8) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  public checkRateLimit(clientIp: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const bucket = this.rateBuckets.get(clientIp);
    if (!bucket) return { allowed: true, retryAfterSeconds: 0 };
    if (bucket.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000)),
      };
    }
    bucket.failures = bucket.failures.filter((ts) => now - ts < this.windowMs);
    if (bucket.failures.length === 0) {
      this.rateBuckets.delete(clientIp);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  public recordAuthAttempt(clientIp: string, success: boolean): void {
    if (success) {
      this.rateBuckets.delete(clientIp);
      return;
    }
    const now = Date.now();
    const bucket = this.rateBuckets.get(clientIp) ?? { failures: [], lockedUntil: 0 };
    bucket.failures = bucket.failures.filter((ts) => now - ts < this.windowMs);
    bucket.failures.push(now);
    if (bucket.failures.length >= this.maxFailures) {
      bucket.lockedUntil = now + this.lockoutMs;
    }
    this.rateBuckets.set(clientIp, bucket);
  }

  private deriveScrypt(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
  }
}

export function resolveClientIp(
  remoteAddress: string | undefined,
  xffHeader: string | string[] | undefined,
  trustProxy: boolean,
): string {
  const peer = (remoteAddress ?? "127.0.0.1").replace(/^::ffff:/, "");
  if (!trustProxy || !xffHeader) return peer;
  const rawXff = Array.isArray(xffHeader) ? xffHeader[0] : xffHeader;
  const candidate = rawXff?.split(",")[0]?.trim().replace(/^::ffff:/, "");
  return candidate && net.isIP(candidate) !== 0 ? candidate : peer;
}

export function verifyWebSocketOrigin(input: {
  readonly originHeader: string | undefined;
  readonly hostHeader: string | undefined;
  readonly publicUrl?: string;
}): boolean {
  if (!input.originHeader) return true;
  try {
    const originUrl = new URL(input.originHeader);
    if (input.hostHeader && originUrl.host.toLowerCase() === input.hostHeader.toLowerCase()) {
      return true;
    }
    if (input.publicUrl) {
      const pub = new URL(input.publicUrl);
      if (originUrl.host.toLowerCase() === pub.host.toLowerCase()) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
