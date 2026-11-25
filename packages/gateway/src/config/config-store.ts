import * as path from "node:path";
import {
  GatewayPersistedConfigSchema,
  type GatewayEnv,
  type GatewayPersistedConfig,
} from "@t3-docker/shared";
import { readJsonWithSchema, writeFileAtomic } from "../utils/atomic-fs.js";

export type ConfigChangeListener = (
  next: GatewayPersistedConfig,
  prev: GatewayPersistedConfig,
) => void;

export class ConfigStore {
  private readonly configFilePath: string;
  private current: GatewayPersistedConfig;
  private readonly listeners = new Set<ConfigChangeListener>();

  public constructor(
    private readonly env: GatewayEnv,
    initial?: GatewayPersistedConfig,
  ) {
    this.configFilePath = path.join(env.T3GW_DATA_DIR, "gateway.config.json");
    this.current = initial ?? GatewayPersistedConfigSchema.parse({});
  }

  public async init(): Promise<GatewayPersistedConfig> {
    let loaded: GatewayPersistedConfig | null = null;
    try {
      loaded = await readJsonWithSchema(this.configFilePath, GatewayPersistedConfigSchema);
    } catch {
      loaded = null;
    }

    const base = loaded ?? GatewayPersistedConfigSchema.parse({});
    const merged = GatewayPersistedConfigSchema.parse({
      ...base,
      ...(this.env.ADMIN_PATH ? { adminPath: this.env.ADMIN_PATH } : {}),
      ...(this.env.VNC_PATH ? { vncPath: this.env.VNC_PATH } : {}),
      ...(this.env.TRUST_PROXY !== undefined ? { trustProxy: this.env.TRUST_PROXY } : {}),
      ...(this.env.PUBLIC_URL ? { publicUrl: this.env.PUBLIC_URL } : {}),
    });

    this.current = merged;
    await writeFileAtomic(this.configFilePath, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
    return this.current;
  }

  public get(): GatewayPersistedConfig {
    return this.current;
  }

  public async update(
    updater:
      | Partial<GatewayPersistedConfig>
      | ((prev: GatewayPersistedConfig) => GatewayPersistedConfig | Partial<GatewayPersistedConfig>),
  ): Promise<GatewayPersistedConfig> {
    const prev = this.current;
    const patch = typeof updater === "function" ? updater(prev) : updater;
    const candidate = {
      ...prev,
      ...patch,
      desktop: {
        ...prev.desktop,
        ...(patch.desktop ?? {}),
      },
      workerEnv: {
        ...prev.workerEnv,
        ...(patch.workerEnv ?? {}),
      },
    };

    const validated = GatewayPersistedConfigSchema.parse(candidate);
    this.current = validated;
    await writeFileAtomic(this.configFilePath, `${JSON.stringify(validated, null, 2)}\n`, 0o600);

    for (const listener of this.listeners) {
      try {
        listener(validated, prev);
      } catch {
        // Listener errors must never corrupt persisted config updates.
      }
    }
    return validated;
  }

  public onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
