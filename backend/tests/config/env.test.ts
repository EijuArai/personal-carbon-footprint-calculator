import { describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";

describe("loadEnv", () => {
  it("applies defaults for missing optional values", () => {
    const env = loadEnv({});

    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("127.0.0.1");
  });

  it("parses explicit environment values", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      PORT: "4100",
      HOST: "0.0.0.0",
      LOG_LEVEL: "debug",
      BACKEND_PUBLIC_BASE_URL: "http://localhost:4100",
    });

    expect(env.NODE_ENV).toBe("test");
    expect(env.PORT).toBe(4100);
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.LOCAL_E2E_WORKER_POLL_INTERVAL_MS).toBe(250);
  });

  it("rejects dev auth bridge when local E2E mode is disabled", () => {
    expect(() => loadEnv({ LOCAL_E2E_DEV_AUTH_ENABLED: "true" })).toThrow(/LOCAL_E2E_MODE/i);
  });

  it("rejects local E2E mode in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production", LOCAL_E2E_MODE: "true" })).toThrow(/must not be enabled in production/i);
  });
});