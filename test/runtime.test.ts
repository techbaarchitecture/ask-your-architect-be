import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

for (const archiveEnabled of [false, true]) {
  test(`real server starts from protected env, serves health, and shuts down (archive ${archiveEnabled ? "enabled" : "disabled"})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ba-runtime-"));
    const envFile = join(dir, ".env");
    assert.equal(
      spawnSync(process.execPath, [
        "--import",
        "tsx",
        "scripts/setup.ts",
        envFile,
      ]).status,
      0,
    );
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        "src/server.ts",
      ],
      {
        env: {
          ...process.env,
          ENV_FILE: envFile,
          PORT: "0",
          DATABASE_PATH: join(dir, "data/app.sqlite"),
          NOCOBASE_API_URL: archiveEnabled
            ? "https://archive-fixture.invalid/api"
            : "",
          NOCOBASE_API_TOKEN: archiveEnabled ? "runtime-fixture-token" : "",
          NOCOBASE_CHAT_COLLECTION: "fixture_architecture_chats",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(
          () => reject(new Error("Server did not listen")),
          5000,
        );
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) {
            clearTimeout(timeout);
            resolve(match[0]);
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`Server exited early: ${code}`));
        });
      });
      assert.equal((await fetch(url + "/api/health")).status, 200);
      const config = (await (
        await fetch(url + "/api/public/config")
      ).json()) as any;
      assert.equal(config.configured, false);
      assert.ok(!JSON.stringify(config).includes("archive-fixture"));
      assert.ok(!JSON.stringify(config).includes("runtime-fixture-token"));
      const db = new DatabaseSync(join(dir, "data/app.sqlite"));
      try {
        const table = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='architecture_chat_outbox'",
          )
          .get();
        assert.equal(
          !!table,
          archiveEnabled,
          "server must wire opt-in archive configuration",
        );
      } finally {
        db.close();
      }
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      assert.equal((await exited)[0], 0);
    } finally {
      if (child.exitCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGKILL");
        await stopped;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("invalid or incomplete archive env fails startup without logging private configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "ba-invalid-archive-"));
  try {
    for (const archive of [
      {
        NOCOBASE_API_URL: "https://user:private-url-secret@example.invalid/api",
        NOCOBASE_API_TOKEN: "private-token-secret",
      },
      {
        NOCOBASE_API_URL: "https://example.invalid/api",
        NOCOBASE_API_TOKEN: "",
      },
      { NOCOBASE_API_URL: "", NOCOBASE_API_TOKEN: "private-token-secret" },
      {
        NOCOBASE_API_URL: "http://127.0.0.1/api",
        NOCOBASE_API_TOKEN: "private-token-secret",
      },
      {
        NOCOBASE_API_URL: "https://example.invalid/api",
        NOCOBASE_API_TOKEN: "private-token-secret",
        NOCOBASE_CHAT_COLLECTION: "../unsafe",
      },
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          "--import",
          "tsx",
          "src/server.ts",
        ],
        {
          env: {
            ...process.env,
            ENV_FILE: join(dir, "nonexistent-env"),
            PORT: "0",
            ADMIN_EMAIL: "runtime@test.local",
            ADMIN_PASSWORD: "runtime-fixture-password",
            ENCRYPTION_KEY: "ab".repeat(32),
            DATABASE_PATH: join(dir, "isolated.sqlite"),
            NOCOBASE_CHAT_COLLECTION: "",
            ...archive,
          },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr.trim(),
        "Invalid server configuration. Run npm run setup and check .env.",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
