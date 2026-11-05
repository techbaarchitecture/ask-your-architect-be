import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { complete } from "../src/provider.js";
import { createApp } from "../src/app.js";

for (const mode of [
  "http-error",
  "partial-error",
  "deadline",
  "redirect",
] as const) {
  test(`SDK rejects ${mode} without retrying or returning partial success`, async () => {
    let calls = 0;
    const fixture = createServer(async (req, res) => {
      for await (const _ of req) {
      }
      calls++;
      if (mode === "http-error") {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: "fixture-key-do-not-leak" }));
        return;
      }
      if (mode === "redirect") {
        res.statusCode = 302;
        res.setHeader("location", "http://169.254.169.254/");
        res.end();
        return;
      }
      res.setHeader("content-type", "text/event-stream");
      res.write(
        "data: " +
          JSON.stringify({
            id: "fixture",
            choices: [
              { index: 0, delta: { content: "Partial" }, finish_reason: null },
            ],
          }) +
          "\n\n",
      );
      if (mode === "deadline") {
        await new Promise((r) => setTimeout(r, 100));
        res.end();
        return;
      }
      res.end(
        "data: " +
          JSON.stringify({
            error: {
              message: "Fixture provider failed",
              type: "server_error",
              code: "upstream_failure",
            },
          }) +
          "\n\n",
      );
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    try {
      await assert.rejects(() =>
        complete(
          {
            provider: "openai-compatible",
            model: "fixture",
            baseUrl: `http://127.0.0.1:${(fixture.address() as any).port}/v1`,
            systemPrompt: "fixture",
            temperature: 0,
            maxTokens: 32,
          },
          "fixture-key-do-not-leak",
          [{ role: "user", content: "fixture" }],
          true,
          mode === "deadline" ? 30 : 1000,
        ),
      );
      assert.equal(calls, 1);
    } finally {
      await new Promise<void>((r) => fixture.close(() => r()));
    }
  });
}

test("SDK provider failures refund device quota and sanitize API responses", async () => {
  const fixture = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ error: { message: "fixture-key-do-not-leak" } }));
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const runtime = createApp({
    dbPath: ":memory:",
    encryptionKey: "ab".repeat(32),
    adminEmail: "sdk@test.local",
    adminPassword: "fixture-password",
    allowedOrigins: [],
    allowPrivateProvider: true,
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const login = (await fetch(base + "/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "sdk@test.local",
        password: "fixture-password",
      }),
    }).then((r) => r.json())) as any;
    const auth = {
      Authorization: `Bearer ${login.token}`,
      "content-type": "application/json",
    };
    const settings = (await fetch(base + "/api/admin/settings", {
      headers: auth,
    }).then((r) => r.json())) as any;
    const save = await fetch(base + "/api/admin/settings", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        ...settings,
        provider: "openai-compatible",
        baseUrl: `http://127.0.0.1:${(fixture.address() as any).port}/v1`,
        apiKey: "fixture-key-do-not-leak",
      }),
    });
    assert.equal(save.status, 200);
    const response = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "sdk-refund",
        messages: [{ role: "user", content: "fixture" }],
      }),
    });
    assert.equal(response.status, 502);
    assert.equal(
      (await response.text()).includes("fixture-key-do-not-leak"),
      false,
    );
    const usage = await fetch(base + "/api/public/usage", {
      headers: { "x-device-id": "sdk-refund" },
    }).then((r) => r.json());
    assert.deepEqual(usage, { used: 0, limit: 3, remaining: 3 });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    runtime.close();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});
