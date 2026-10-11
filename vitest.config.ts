import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEV_LOGIN: "1",
            GITHUB_CLIENT_ID: "test-client",
            GITHUB_CLIENT_SECRET: "test-secret",
            QUOTA_APPLY_PER_DAY: "3",
            QUOTA_INVITE_PER_JOB_PER_DAY: "2",
            QUOTA_SEARCH_PER_MIN: "1000",
            QUOTA_POLL_PER_MIN: "1000",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
