import { GatewayEnvSchema } from "@t3-docker/shared";
import { buildGatewayApp } from "./app.js";
import { T3AuthBridge } from "./auth-bridge/t3-auth-bridge.js";
import { ConfigStore } from "./config/config-store.js";
import { T3ConnectService } from "./connect/t3-connect-service.js";
import { DesktopSupervisor } from "./desktop/desktop-supervisor.js";
import { ProviderToolchainService } from "./providers/provider-service.js";
import { GatewayAuthService } from "./security/auth-service.js";
import { consumeAndScrubProcessSecrets } from "./security/env-sanitizer.js";
import { SnapshotService } from "./snapshots/snapshot-service.js";
import { T3ProcessSupervisor } from "./supervisor/t3-supervisor.js";
import { VersionHubService } from "./versions/version-hub.js";

async function bootstrap(): Promise<void> {
  // 1. Consume & immediately scrub sensitive secrets from process.env before spawning anything
  const secrets = consumeAndScrubProcessSecrets(process.env);
  const gatewayEnv = GatewayEnvSchema.parse(process.env);

  // 2. Initialize persisted configuration & authentication stores
  const configStore = new ConfigStore(gatewayEnv);
  await configStore.init();

  const authService = new GatewayAuthService(gatewayEnv.T3GW_DATA_DIR);
  await authService.init(secrets);

  // 3. Assemble domain services
  const authBridge = new T3AuthBridge(gatewayEnv, configStore);
  const supervisor = new T3ProcessSupervisor(gatewayEnv, configStore);
  const desktopSupervisor = new DesktopSupervisor(gatewayEnv, configStore, authBridge);
  const snapshotService = new SnapshotService(
    gatewayEnv,
    configStore,
    supervisor,
    desktopSupervisor,
  );
  const versionHub = new VersionHubService(
    gatewayEnv,
    configStore,
    supervisor,
    snapshotService,
    desktopSupervisor,
  );
  const connectService = new T3ConnectService(gatewayEnv, configStore, supervisor);
  const providerService = new ProviderToolchainService(
    gatewayEnv,
    configStore,
    supervisor,
    desktopSupervisor,
  );
  await providerService.init();
  await desktopSupervisor.syncLocaleFromGateway(configStore.get().locale).catch(() => undefined);

  // 4. Build and listen on unified gateway port
  const app = await buildGatewayApp({
    gatewayEnv,
    configStore,
    authService,
    authBridge,
    supervisor,
    versionHub,
    desktopSupervisor,
    connectService,
    providerService,
    snapshotService,
  });

  await app.listen({
    host: gatewayEnv.PROXY_HOST,
    port: gatewayEnv.PROXY_PORT,
  });

  const cfg = configStore.get();
  process.stdout.write(
    `[t3-gateway] Listening on http://${gatewayEnv.PROXY_HOST}:${gatewayEnv.PROXY_PORT} (admin=${cfg.adminPath}, vnc=${cfg.vncPath}, variant=${gatewayEnv.T3GW_VARIANT})\n`,
  );

  // 5. Start upstream `t3 serve` and optional first-boot Agent CLI preinstall
  await supervisor.start();
  providerService.startBackgroundPreinstallIfNeeded();

  // 6. Graceful shutdown on SIGTERM / SIGINT
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[t3-gateway] Received ${signal}; shutting down gracefully...\n`);
    await Promise.allSettled([
      app.close(),
      desktopSupervisor.shutdown(),
      supervisor.stop(),
    ]);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void bootstrap().catch((err) => {
  process.stderr.write(`[t3-gateway] Fatal startup error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

export * from "./app.js";
