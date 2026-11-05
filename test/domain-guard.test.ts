import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp } from "../src/app.js";

async function harness(decision = "BLOCK_EN") {
  const calls: any[] = [];
  let current = decision;
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    calls.push(body);
    const classifier = body.messages[0]?.content.includes(
      "ARCHITECTURE_SCOPE_CLASSIFIER",
    );
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: classifier ? current : "Architecture fixture answer",
            },
          },
        ],
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const runtime = createApp({
    dbPath: ":memory:",
    encryptionKey: "ab".repeat(32),
    adminEmail: "scope@test.local",
    adminPassword: "scope-fixture-password",
    allowedOrigins: [],
    allowPrivateProvider: true,
  });
  const server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = async (path: string, body?: unknown, token?: string) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: (await r.json()) as any };
  };
  const token = (
    await request("/api/admin/login", {
      email: "scope@test.local",
      password: "scope-fixture-password",
    })
  ).data.token;
  const settings = (await request("/api/admin/settings", undefined, token))
    .data;
  const saved = await fetch(base + "/api/admin/settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      ...settings,
      apiKey: "scope-fixture-key",
      baseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
      systemPrompt: "Studio style: concise and friendly.",
    }),
  });
  assert.equal(saved.status, 200);
  return {
    calls,
    request,
    usage: async (deviceId: string) =>
      fetch(base + "/api/public/usage", {
        headers: { "x-device-id": deviceId },
      }).then((r) => r.json()),
    setDecision: (value: string) => {
      current = value;
    },
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      runtime.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    },
  };
}

test("off-topic questions are refused server-side without answering or charging quota", async () => {
  const h = await harness();
  try {
    const r = await h.request("/api/chat", {
      deviceId: "scope-device",
      messages: [
        { role: "user", content: "Which stock should I buy tomorrow?" },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.blocked, true);
    assert.equal(r.data.code, "OFF_TOPIC");
    assert.match(r.data.reply, /architect/i);
    assert.deepEqual(r.data.usage, { used: 0, limit: 3, remaining: 3 });
    assert.equal(h.calls.length, 1);
    h.setDecision("BLOCK_VI");
    const vi = await h.request("/api/chat", {
      deviceId: "scope-device",
      messages: [{ role: "user", content: "Hướng dẫn tôi làm bánh sinh nhật" }],
    });
    assert.equal(vi.data.blocked, true);
    assert.match(vi.data.reply, /kiến trúc/);
    assert.equal(vi.data.usage.used, 0);
  } finally {
    await h.close();
  }
});

test("architecture follow-ups use context and retain locked policy plus studio instructions", async () => {
  const h = await harness("ALLOW");
  try {
    const messages = [
      { role: "user", content: "I am renovating a 60m² apartment." },
      { role: "assistant", content: "Start with a survey." },
      { role: "user", content: "What about the budget?" },
    ];
    const r = await h.request("/api/chat", {
      deviceId: "scope-context",
      messages,
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.reply, "Architecture fixture answer");
    assert.equal(r.data.usage.used, 1);
    assert.equal(h.calls.length, 2);
    assert.match(
      h.calls[0].messages[0].content,
      /ARCHITECTURE_SCOPE_CLASSIFIER/,
    );
    assert.match(h.calls[0].messages[1].content, /60m²/);
    assert.match(h.calls[0].messages[1].content, /What about the budget/);
    const prompt = h.calls[1].messages[0].content;
    assert.match(prompt, /ARCHITECTURE_ONLY_POLICY/);
    assert.match(prompt, /Studio style: concise and friendly/);
  } finally {
    await h.close();
  }
});

test("malformed classifier decisions fail closed and refund the reserved question", async () => {
  const h = await harness("Sure, let me answer your question");
  try {
    const r = await h.request("/api/chat", {
      deviceId: "scope-invalid",
      messages: [{ role: "user", content: "Explain reinforced concrete" }],
    });
    assert.equal(r.status, 502);
    assert.equal(h.calls.length, 1);
    const retry = await h.request("/api/chat", {
      deviceId: "scope-invalid",
      messages: [{ role: "user", content: "Explain reinforced concrete" }],
    });
    assert.equal(retry.status, 502);
    assert.deepEqual(await h.usage("scope-invalid"), {
      used: 0,
      limit: 3,
      remaining: 3,
    });
    for (const malformed of [
      '{"decision":"ALLOW"}',
      "allow",
      "ALLOW with explanation",
      "",
    ]) {
      h.setDecision(malformed);
      const failed = await h.request("/api/chat", {
        deviceId: "scope-invalid",
        messages: [{ role: "user", content: "Explain reinforced concrete" }],
      });
      assert.equal(failed.status, 502);
      assert.deepEqual(await h.usage("scope-invalid"), {
        used: 0,
        limit: 3,
        remaining: 3,
      });
    }
    assert.equal(h.calls.length, 6);
    h.setDecision("ALLOW");
    const valid = await h.request("/api/chat", {
      deviceId: "scope-invalid",
      messages: [{ role: "user", content: "Explain reinforced concrete" }],
    });
    assert.equal(valid.status, 200);
    assert.equal(valid.data.usage.used, 1);
  } finally {
    await h.close();
  }
});
