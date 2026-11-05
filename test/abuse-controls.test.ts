import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { parseTrustProxy } from "../src/security.js";
import { completeStream } from "../src/provider.js";

test("TRUST_PROXY rejects blanket true and keeps default off", () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(""), false);
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("loopback"), "loopback");
  assert.deepEqual(parseTrustProxy("127.0.0.1,::1"), ["127.0.0.1", "::1"]);
  assert.throws(() => parseTrustProxy("true"), /not allowed/);
});

async function appHarness(
  overrides: Record<string, unknown> = {},
  listenHost = "127.0.0.1",
) {
  const runtime = createApp({
    dbPath: ":memory:",
    encryptionKey: "ab".repeat(32),
    adminEmail: "abuse@test.local",
    adminPassword: "abuse-fixture-password",
    allowedOrigins: [],
    allowPrivateProvider: true,
    ...overrides,
  });
  const server = runtime.app.listen(0, listenHost);
  await once(server, "listening");
  const addr = server.address() as { port: number };
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    runtime,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.close();
    },
  };
}

test("spoofed forwarded headers do not split rate-limit buckets without trust proxy", async () => {
  const h = await appHarness();
  try {
    for (let i = 0; i < 120; i++) {
      const res = await fetch(h.origin + "/api/public/config", {
        headers: { "x-forwarded-for": `203.0.113.${i % 250}` },
      });
      assert.equal(res.status, 200);
    }
    const blocked = await fetch(h.origin + "/api/public/config", {
      headers: { "x-forwarded-for": "198.51.100.9" },
    });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, "RATE_LIMITED");
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    assert.match(blocked.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/i);
  } finally {
    await h.close();
  }
});

test("trusted hop uses CF-Connecting-IP then X-Forwarded-For from that hop only", async () => {
  const h = await appHarness({ trustProxy: 1 });
  try {
    for (let i = 0; i < 120; i++) {
      const res = await fetch(h.origin + "/api/public/config", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      });
      assert.equal(res.status, 200);
    }
    assert.equal(
      (
        await fetch(h.origin + "/api/public/config", {
          headers: { "x-forwarded-for": "203.0.113.10" },
        })
      ).status,
      429,
    );
    const other = await fetch(h.origin + "/api/public/config", {
      headers: { "cf-connecting-ip": "198.51.100.20" },
    });
    assert.equal(other.status, 200);
  } finally {
    await h.close();
  }
});

test("chat and stream share a 10/minute IP cap separate from public reads", async () => {
  const h = await appHarness();
  try {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(h.origin + "/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": `device-${i}`,
        },
        body: JSON.stringify({
          deviceId: `device-${i}`,
          messages: [{ role: "user", content: "Hello" }],
        }),
      });
      assert.equal(res.status, 503);
    }
    const limited = await fetch(h.origin + "/api/chat/stream", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "another-device",
      },
      body: JSON.stringify({
        deviceId: "another-device",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).code, "RATE_LIMITED");
    assert.equal((await fetch(h.origin + "/api/public/config")).status, 200);
    assert.equal((await fetch(h.origin + "/api/health")).status, 200);
  } finally {
    await h.close();
  }
});

test("request logs omit secrets and include request id, route, status, ip", async () => {
  const logs: any[] = [];
  const h = await appHarness({
    onRequestLog: (entry: unknown) => logs.push(entry),
  });
  try {
    await fetch(h.origin + "/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "abuse@test.local",
        password: "abuse-fixture-password",
      }),
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].method, "POST");
    assert.equal(logs[0].path, "/api/admin/login");
    assert.equal(logs[0].status, 200);
    assert.equal(typeof logs[0].ms, "number");
    assert.equal(typeof logs[0].ip, "string");
    assert.match(logs[0].requestId, /^[0-9a-f-]{36}$/i);
    assert.equal(JSON.stringify(logs[0]).includes("abuse-fixture-password"), false);
    assert.equal(JSON.stringify(logs[0]).includes("token"), false);
  } finally {
    await h.close();
  }
});

async function delayedProvider(delayMs: number) {
  let inflight = 0;
  let streamRequests = 0;
  const upstream = createServer(async (req, res) => {
    inflight++;
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw || "{}");
    const classifier = JSON.stringify(body).includes(
      "ARCHITECTURE_SCOPE_CLASSIFIER",
    );
    if (body.stream === true) {
      streamRequests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const timer = setTimeout(() => {
        inflight--;
        res.write(
          "data: " +
            JSON.stringify({
              choices: [{ delta: { content: "Architecture stream" }, finish_reason: "stop" }],
            }) +
            "\n\n",
        );
        res.end();
      }, delayMs);
      req.on("close", () => {
        inflight = Math.max(0, inflight - 1);
        clearTimeout(timer);
      });
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      req.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    inflight--;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: classifier ? "ALLOW" : "Architecture fixture answer",
            },
          },
        ],
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  return {
    baseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
    inflight: () => inflight,
    streamRequests: () => streamRequests,
    close: () => new Promise<void>((resolve) => upstream.close(() => resolve())),
  };
}

async function configureChat(origin: string, baseUrl: string) {
  const login = await fetch(origin + "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "abuse@test.local",
      password: "abuse-fixture-password",
    }),
  });
  const token = (await login.json()).token as string;
  const settings = await (
    await fetch(origin + "/api/admin/settings", {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  const saved = await fetch(origin + "/api/admin/settings", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      ...settings,
      apiKey: "fixture-key",
      baseUrl,
      questionLimit: 20,
    }),
  });
  assert.equal(saved.status, 200);
}

test("chat allows two in-flight provider jobs per IP and rejects the third", async () => {
  const provider = await delayedProvider(400);
  const h = await appHarness({
    chatMaxConcurrentPerIp: 2,
    chatMaxConcurrent: 8,
  });
  try {
    await configureChat(h.origin, provider.baseUrl);
    const send = (device: string) =>
      fetch(h.origin + "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: device,
          messages: [{ role: "user", content: "Need a small kitchen layout" }],
        }),
      });
    const pending = [send("a"), send("b"), send("c")];
    const results = await Promise.all(pending);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 429]);
    const limited = results.find((r) => r.status === 429)!;
    assert.equal((await limited.json()).code, "RATE_LIMITED");
  } finally {
    await h.close();
    await provider.close();
  }
});

test("client disconnect aborts the provider stream and refunds quota", async () => {
  const provider = await delayedProvider(5000);
  const h = await appHarness();
  try {
    await configureChat(h.origin, provider.baseUrl);
    const ac = new AbortController();
    const pending = fetch(h.origin + "/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "stream-abort",
        messages: [{ role: "user", content: "Need a small kitchen layout" }],
      }),
      signal: ac.signal,
    });
    const started = Date.now();
    while (provider.inflight() === 0 && Date.now() - started < 1000)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(provider.inflight() > 0);
    ac.abort();
    await assert.rejects(() => pending);
    await new Promise((r) => setTimeout(r, 50));
    const usage = await (
      await fetch(h.origin + "/api/public/usage", {
        headers: { "x-device-id": "stream-abort" },
      })
    ).json();
    assert.equal(usage.used, 0);
    assert.equal(usage.remaining, 20);
  } finally {
    await h.close();
    await provider.close();
  }
});

test("completeStream stops upstream work when aborted", async () => {
  let cancelled = false;
  let seen = false;
  const fixture = createServer(async (req, res) => {
    seen = true;
    req.on("close", () => {
      cancelled = true;
    });
    let raw = "";
    for await (const part of req) raw += part;
    if (cancelled) return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setTimeout(() => {
      res.write(
        "data: " +
          JSON.stringify({
            choices: [{ delta: { content: "late" }, finish_reason: "stop" }],
          }) +
          "\n\n",
      );
      res.end();
    }, 5000);
    req.on("close", () => clearTimeout(timer));
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const ac = new AbortController();
  try {
    const gen = completeStream(
      {
        provider: "openai",
        model: "fixture",
        baseUrl: `http://127.0.0.1:${(fixture.address() as any).port}/v1`,
        systemPrompt: "test",
        temperature: 0,
        maxTokens: 16,
      },
      "k",
      [{ role: "user", content: "hi" }],
      true,
      60000,
      ac.signal,
    );
    const consume = gen.next();
    const started = Date.now();
    while (!seen && Date.now() - started < 1000)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen, true);
    ac.abort();
    await assert.rejects(() => consume);
    const waitCancel = Date.now();
    while (!cancelled && Date.now() - waitCancel < 1000)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(cancelled, true);
  } finally {
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});
