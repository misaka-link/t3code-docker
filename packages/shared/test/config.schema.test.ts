import { describe, expect, it } from "vitest";
import {
  CustomRoutePathSchema,
  GatewayEnvSchema,
  GatewayPersistedConfigSchema,
  isReservedRoutePath,
  normalizeRoutePath,
} from "../src/index.js";

describe("@t3-docker/shared route and config schemas", () => {
  it("normalizes leading and trailing slashes cleanly", () => {
    expect(normalizeRoutePath("admin/")).toBe("/admin");
    expect(normalizeRoutePath("/console///")).toBe("/console");
    expect(normalizeRoutePath("/")).toBe("/");
  });

  it("rejects reserved T3 Code and internal gateway routes", () => {
    for (const reserved of ["/", "/pair", "/pair/sub", "/api", "/mcp", "/.well-known", "/_t3gw", "/_t3gw/api"]) {
      expect(isReservedRoutePath(normalizeRoutePath(reserved))).toBe(true);
      expect(CustomRoutePathSchema.safeParse(reserved).success).toBe(false);
    }
  });

  it("accepts valid custom admin and vnc paths", () => {
    expect(CustomRoutePathSchema.parse("admin")).toBe("/admin");
    expect(CustomRoutePathSchema.parse("/t3-console/")).toBe("/t3-console");
    expect(CustomRoutePathSchema.parse("/remote_vnc")).toBe("/remote_vnc");
  });

  it("defaults locale to zh-CN and prevents adminPath/vncPath collision", () => {
    const defaults = GatewayPersistedConfigSchema.parse({});
    expect(defaults.locale).toBe("zh-CN");
    expect(defaults.adminPath).toBe("/admin");
    expect(defaults.vncPath).toBe("/vnc");

    const collided = GatewayPersistedConfigSchema.safeParse({
      adminPath: "/panel",
      vncPath: "/panel",
    });
    expect(collided.success).toBe(false);

    const nested = GatewayPersistedConfigSchema.safeParse({
      adminPath: "/panel",
      vncPath: "/panel/vnc",
    });
    expect(nested.success).toBe(false);
  });

  it("parses GatewayEnvSchema with safe defaults and boolean coercion", () => {
    const env = GatewayEnvSchema.parse({
      PROXY_PORT: "3080",
      TRUST_PROXY: "1",
      T3GW_VARIANT: "headless",
    });
    expect(env.PROXY_PORT).toBe(3080);
    expect(env.TRUST_PROXY).toBe(true);
    expect(env.T3GW_VARIANT).toBe("headless");
  });
});
