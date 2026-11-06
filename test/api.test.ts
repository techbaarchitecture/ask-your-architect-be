import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";

async function harness(
  dbPath?: string,
  overrides: Record<string, unknown> = {},
) {
  const mod = await import("../src/app.js").catch(() => null);
  assert.equal(
    typeof mod?.createApp,
    "function",
    "HTTP application factory must exist",
  );
  const dir = mkdtempSync(join(tmpdir(), "ba-api-"));
  const runtime = mod!.createApp({
    dbPath: dbPath ?? join(dir, "test.sqlite"),
    encryptionKey: "ab".repeat(32),
    adminEmail: "admin@test.local",
    adminPassword: "test-password-long-enough",
    allowedOrigins: ["http://localhost:5178"],
    allowPrivateProvider: true,
    ...overrides,
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as { port: number };
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    token?: string,
    device?: string,
  ) => {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(device ? { "x-device-id": device } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, headers: res.headers };
  };
  return {
    ...runtime,
    url: `http://127.0.0.1:${addr.port}`,
    dir,
    request,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("public defaults expose no secrets and health is available", async () => {
  const h = await harness();
  try {
    const c = await h.request("/api/public/config");
    assert.equal(c.status, 200);
    assert.equal(c.data.companyName, "B+A Architecture");
    assert.equal(c.data.companyUrl, "");
    assert.equal(c.data.questionLimit, 3);
    assert.equal(c.data.configured, false);
    assert.equal(c.data.apiKey, undefined);
    assert.equal(c.data.quickQuestions.en.length, 4);
    assert.equal(c.data.quickQuestions.vi[0].title, "Khám phá không gian");
    assert.equal(
      c.data.welcomeTexts.vi,
      "Chào mừng đến B+A Architecture. Chúng tôi có thể giúp gì?",
    );
    assert.equal((await h.request("/api/health")).data.ok, true);
    assert.deepEqual(
      (
        await h.request(
          "/api/public/usage",
          "GET",
          undefined,
          undefined,
          "device-default",
        )
      ).data,
      { used: 0, limit: 3, remaining: 3 },
    );
  } finally {
    await h.close();
  }
});

test("settings validate edits and encrypt keys without returning plaintext", async () => {
  const h = await harness();
  try {
    const token = (
      await h.request("/api/admin/login", "POST", {
        email: "admin@test.local",
        password: "test-password-long-enough",
      })
    ).data.token;
    const before = (
      await h.request("/api/admin/settings", "GET", undefined, token)
    ).data;
    assert.equal(before.apiKeyConfigured, false);
    const save = await h.request(
      "/api/admin/settings",
      "PUT",
      {
        ...before,
        apiKey: "fixture-secret-key",
        companyName: "Edited",
        questionLimit: 5,
      },
      token,
    );
    assert.equal(save.status, 200);
    const after = (
      await h.request("/api/admin/settings", "GET", undefined, token)
    ).data;
    assert.equal(after.companyName, "Edited");
    assert.equal(after.apiKeyConfigured, true);
    assert.equal(after.apiKeyHint.includes("fixture"), false);
    assert.equal(JSON.stringify(after).includes("fixture-secret-key"), false);
    assert.equal(
      (
        await h.request(
          "/api/admin/settings",
          "PUT",
          { ...after, apiKey: "", questionLimit: 0 },
          token,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request(
          "/api/admin/settings",
          "PUT",
          { ...after, apiKey: "" },
          token,
        )
      ).status,
      200,
    );
    assert.equal((await h.request("/api/public/config")).data.configured, true);
    const { readFileSync } = await import("node:fs");
    for (const name of ["test.sqlite", "test.sqlite-wal"]) {
      const data = readFileSync(join(h.dir, name));
      assert.equal(data.includes(Buffer.from("fixture-secret-key")), false);
    }
  } finally {
    await h.close();
  }
});

test("provider draft test uses real HTTP fixture for all integrations and never saves draft keys", async () => {
  const observed: any[] = [];
  const fixture = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    observed.push({
      path: req.url,
      headers: req.headers,
      body: JSON.parse(raw),
    });
    if (JSON.parse(raw).stream === true) {
      res.setHeader("content-type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            id: "fixture",
            choices: [
              {
                index: 0,
                delta: { content: "Fixture response" },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.includes("generateContent")
          ? {
              candidates: [
                { content: { parts: [{ text: "Fixture response" }] } },
              ],
            }
          : req.url?.endsWith("/messages")
            ? { content: [{ type: "text", text: "Fixture response" }] }
            : { choices: [{ message: { content: "Fixture response" } }] },
      ),
    );
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const h = await harness();
  try {
    const token = (
      await h.request("/api/admin/login", "POST", {
        email: "admin@test.local",
        password: "test-password-long-enough",
      })
    ).data.token;
    for (const provider of [
      "openai",
      "openai-compatible",
      "anthropic",
      "gemini",
    ]) {
      const result = await h.request(
        "/api/admin/test",
        "POST",
        {
          provider,
          model: "fixture-model",
          baseUrl: `http://127.0.0.1:${(fixture.address() as any).port}/v1`,
          apiKey: "fixture-draft-key",
        },
        token,
      );
      assert.equal(result.status, 200);
      assert.equal(result.data.ok, true);
      assert.equal(result.data.model, "fixture-model");
    }
    assert.equal(observed.length, 4);
    assert.equal(observed[0].headers.authorization, "Bearer fixture-draft-key");
    assert.equal(observed[2].headers["x-api-key"], "fixture-draft-key");
    assert.equal(observed[3].headers["x-goog-api-key"], "fixture-draft-key");
    assert.equal(
      (await h.request("/api/admin/settings", "GET", undefined, token)).data
        .apiKeyConfigured,
      false,
    );
  } finally {
    await h.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});

test("chat reserves quota atomically, persists on restart, and refunds provider failure", async () => {
  let fail = false;
  const fixture = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const classifier = JSON.parse(raw).messages[0]?.content.includes(
      "ARCHITECTURE_SCOPE_CLASSIFIER",
    );
    await new Promise((r) => setTimeout(r, 30));
    res.setHeader("content-type", "application/json");
    res.statusCode = fail ? 401 : 200;
    res.end(
      JSON.stringify(
        fail
          ? { error: "fixture-secret-key" }
          : {
              choices: [
                {
                  message: {
                    content: classifier
                      ? "ALLOW"
                      : "Architecture fixture reply",
                  },
                },
              ],
            },
      ),
    );
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const dir = mkdtempSync(join(tmpdir(), "ba-persist-"));
  const dbPath = join(dir, "persist.sqlite");
  let h = await harness(dbPath, {
    chatMaxConcurrentPerIp: 8,
    chatMaxConcurrent: 16,
  });
  try {
    const body = {
      deviceId: "concurrent-device",
      messages: [{ role: "user", content: "Design a house" }],
    };
    assert.equal((await h.request("/api/chat", "POST", body)).status, 503);
    const token = (
      await h.request("/api/admin/login", "POST", {
        email: "admin@test.local",
        password: "test-password-long-enough",
      })
    ).data.token;
    const settings = (
      await h.request("/api/admin/settings", "GET", undefined, token)
    ).data;
    assert.equal(
      (
        await h.request(
          "/api/admin/settings",
          "PUT",
          {
            ...settings,
            apiKey: "fixture-secret-key",
            baseUrl: `http://127.0.0.1:${(fixture.address() as any).port}/v1`,
          },
          token,
        )
      ).status,
      200,
    );
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => h.request("/api/chat", "POST", body)),
    );
    assert.equal(responses.filter((r) => r.status === 200).length, 3);
    assert.equal(
      responses.filter(
        (r) => r.status === 429 && r.data.code === "QUOTA_EXCEEDED",
      ).length,
      2,
    );
    assert.equal(
      responses.find((r) => r.status === 200)!.data.reply,
      "Architecture fixture reply",
    );
    assert.deepEqual(
      (
        await h.request(
          "/api/public/usage",
          "GET",
          undefined,
          undefined,
          body.deviceId,
        )
      ).data,
      { used: 3, limit: 3, remaining: 0 },
    );
    await h.close();
    h = await harness(dbPath);
    assert.equal(
      (await h.request("/api/admin/settings", "GET", undefined, token)).status,
      200,
    );
    assert.equal((await h.request("/api/chat", "POST", body)).status, 429);
    fail = true;
    const bad = await h.request("/api/chat", "POST", {
      ...body,
      deviceId: "refund-device",
    });
    assert.equal(bad.status, 502);
    assert.equal(
      JSON.stringify(bad.data).includes("fixture-secret-key"),
      false,
    );
    assert.equal(
      (
        await h.request(
          "/api/public/usage",
          "GET",
          undefined,
          undefined,
          "refund-device",
        )
      ).data.used,
      0,
    );
  } finally {
    await h.close();
    await new Promise<void>((r) => fixture.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chat returns a guest-safe daily pause when the provider spend limit is hit", async () => {
  const fixture = createServer(async (req, res) => {
    res.statusCode = 402;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({ error: { message: "Key has exceeded its spending limit" } }),
    );
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const h = await harness();
  try {
    const token = (
      await h.request("/api/admin/login", "POST", {
        email: "admin@test.local",
        password: "test-password-long-enough",
      })
    ).data.token;
    const settings = (
      await h.request("/api/admin/settings", "GET", undefined, token)
    ).data;
    assert.equal(
      (
        await h.request(
          "/api/admin/settings",
          "PUT",
          {
            ...settings,
            provider: "openai-compatible",
            apiKey: "fixture-key",
            baseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
          },
          token,
        )
      ).status,
      200,
    );
    const paused = await h.request("/api/chat", "POST", {
      deviceId: "daily-pause-device",
      messages: [{ role: "user", content: "Design a house" }],
    });
    assert.equal(paused.status, 503);
    assert.equal(paused.data.code, "DAILY_PAUSE");
    assert.match(paused.data.error, /come back tomorrow/i);
    assert.equal(/\$|credit|budget|spend/i.test(JSON.stringify(paused.data)), false);
    assert.equal(
      (
        await h.request(
          "/api/public/usage",
          "GET",
          undefined,
          undefined,
          "daily-pause-device",
        )
      ).data.used,
      0,
    );
  } finally {
    await h.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});

test("HTTP security restricts origins, validates devices/messages and caps request bodies", async () => {
  const h = await harness();
  try {
    const allowed = await fetch(h.url + "/api/public/config", {
      headers: { origin: "http://localhost:5178" },
    });
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "http://localhost:5178",
    );
    assert.equal(allowed.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      (
        await fetch(h.url + "/api/public/config", {
          headers: { origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal((await h.request("/api/public/usage")).status, 400);
    assert.equal(
      (
        await h.request("/api/chat", "POST", {
          deviceId: "abc",
          messages: [{ role: "system", content: "bypass" }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request(
          "/api/chat",
          "POST",
          { deviceId: "one", messages: [{ role: "user", content: "hi" }] },
          undefined,
          "two",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await h.request("/api/chat", "POST", {
          deviceId: "abc",
          messages: [{ role: "user", content: "x".repeat(70000) }],
        })
      ).status,
      413,
    );
    const invalid = await fetch(h.url + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"password":"secret-body"',
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.text()).includes("secret-body"), false);
    assert.equal((await h.request("/not-a-route")).data.error, "Not found");
  } finally {
    await h.close();
  }
});

test("SSRF protection rejects private and metadata provider URLs before storing or connecting", async () => {
  const h = await harness(undefined, { allowPrivateProvider: false });
  try {
    const token = (
      await h.request("/api/admin/login", "POST", {
        email: "admin@test.local",
        password: "test-password-long-enough",
      })
    ).data.token;
    const settings = (
      await h.request("/api/admin/settings", "GET", undefined, token)
    ).data;
    for (const baseUrl of [
      "http://127.0.0.1:9/v1",
      "http://169.254.169.254/latest",
      "http://10.0.0.1/v1",
      "http://[::1]/v1",
      "https://user:password@example.com/v1",
      "file:///etc/passwd",
      "https://metadata.google.internal/v1",
    ]) {
      assert.equal(
        (
          await h.request(
            "/api/admin/settings",
            "PUT",
            { ...settings, baseUrl },
            token,
          )
        ).status,
        400,
        baseUrl,
      );
      assert.equal(
        (
          await h.request(
            "/api/admin/test",
            "POST",
            { provider: "openai", model: "fixture", baseUrl, apiKey: "secret" },
            token,
          )
        ).status,
        400,
        baseUrl,
      );
    }
  } finally {
    await h.close();
  }
  const local = await harness();
  try {
    const token = (
      await local.request("/api/admin/login", "POST", {
        email: "admin@test.local",
        password: "test-password-long-enough",
      })
    ).data.token;
    const settings = (
      await local.request("/api/admin/settings", "GET", undefined, token)
    ).data;
    assert.equal(
      (
        await local.request(
          "/api/admin/settings",
          "PUT",
          { ...settings, baseUrl: "http://169.254.169.254/v1" },
          token,
        )
      ).status,
      400,
    );
  } finally {
    await local.close();
  }
});

test("login and public endpoints apply bounded IP rate limits", async () => {
  const h = await harness();
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await h.request("/api/admin/login", "POST", {
            email: "nobody",
            password: "wrong",
          })
        ).status,
        401,
      );
    const login = await h.request("/api/admin/login", "POST", {
      email: "nobody",
      password: "wrong",
    });
    assert.equal(login.status, 429);
    assert.equal(login.data.code, "RATE_LIMITED");
    for (let i = 0; i < 120; i++)
      assert.equal((await h.request("/api/public/config")).status, 200);
    assert.equal((await h.request("/api/public/config")).status, 429);
  } finally {
    await h.close();
  }
});

test("setup generates private random credentials without logging or overwriting secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "ba-setup-"));
  const file = join(dir, ".env");
  try {
    const run = () =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/setup.ts", file],
        { encoding: "utf8" },
      );
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const env = readFileSync(file, "utf8");
    const password = env.match(/^ADMIN_PASSWORD=(.+)$/m)![1];
    assert.ok(password.length >= 32);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(result.stdout.includes(password), false);
    assert.match(env, /ENCRYPTION_KEY=[a-f0-9]{64}/);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(file, "utf8"), env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("admin rejects authorization without the Bearer scheme", async () => {
  const h = await harness();
  try {
    const token = (
      await h.request("/api/admin/login", "POST", {
        email: "admin@test.local",
        password: "test-password-long-enough",
      })
    ).data.token;
    assert.equal(
      (
        await fetch(h.url + "/api/admin/settings", {
          headers: { authorization: token },
        })
      ).status,
      401,
    );
  } finally {
    await h.close();
  }
});

test("admin authenticates with opaque persistent sessions and logout revokes", async () => {
  const h = await harness();
  try {
    assert.equal((await h.request("/api/admin/settings")).status, 401);
    assert.equal(
      (
        await h.request("/api/admin/login", "POST", {
          email: "admin@test.local",
          password: "wrong",
        })
      ).status,
      401,
    );
    const login = await h.request("/api/admin/login", "POST", {
      email: "admin@test.local",
      password: "test-password-long-enough",
    });
    assert.equal(login.status, 200);
    assert.match(login.data.token, /^[a-f0-9]{64}$/);
    assert.equal(
      (
        await h.request(
          "/api/admin/settings",
          "GET",
          undefined,
          login.data.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (await h.request("/api/admin/logout", "POST", {}, login.data.token))
        .status,
      200,
    );
    assert.equal(
      (
        await h.request(
          "/api/admin/settings",
          "GET",
          undefined,
          login.data.token,
        )
      ).status,
      401,
    );
  } finally {
    await h.close();
  }
});
