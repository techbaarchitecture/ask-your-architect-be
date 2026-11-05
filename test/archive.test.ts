import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createApp, type Options } from "../src/app.js";

const answer =
  "## Architecture fixture\n\nFull **markdown** answer.\n\n- Retain this line.";
async function harness() {
  const directory = mkdtempSync(join(tmpdir(), "aya-archive-"));
  const dbPath = join(directory, "test.sqlite");
  const remoteRows: any[] = [];
  const remoteCalls: { method: string; url: string; body: any }[] = [];
  const providerTimes: number[] = [];
  let decision = "ALLOW";
  let providerFailure = false;
  let offline = false;
  let createMode = "normal";
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw || "null");
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/")) {
      remoteCalls.push({ method: req.method!, url: req.url, body });
      assert.equal(req.headers.authorization, "Bearer archive-fixture-token");
      if (offline) {
        res.writeHead(503).end("unavailable");
        return;
      }
      if (req.method === "GET") {
        const url = new URL(req.url, "http://fixture");
        const id = JSON.parse(url.searchParams.get("filter")!).event_id.$eq;
        assert.equal(url.searchParams.get("pageSize"), "1");
        res.end(
          JSON.stringify({
            data: remoteRows.filter((row) => row.event_id === id),
          }),
        );
      } else {
        if (createMode === "false-ack") {
          res.end(JSON.stringify({ data: {} }));
          return;
        }
        remoteRows.push(body);
        if (createMode === "lost-ack-unconfirmed") {
          offline = true;
          req.socket.destroy();
          return;
        }
        if (createMode === "duplicate") {
          res.writeHead(409).end("duplicate");
          return;
        }
        if (createMode === "lost-ack") {
          req.socket.destroy();
          return;
        }
        res.end(JSON.stringify({ data: body }));
      }
      return;
    }
    const classifier = body.messages[0]?.content.includes(
      "ARCHITECTURE_SCOPE_CLASSIFIER",
    );
    providerTimes.push(Date.now());
    if (decision === "classifier-error" && classifier) {
      res.writeHead(500).end("classifier failed");
      return;
    }
    if (providerFailure && !classifier) {
      res.writeHead(500).end("provider failed");
      return;
    }
    res.end(
      JSON.stringify({
        choices: [{ message: { content: classifier ? decision : answer } }],
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const origin = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const options: Options = {
    dbPath,
    encryptionKey: "ab".repeat(32),
    adminEmail: "archive@test.local",
    adminPassword: "archive-test-password",
    allowedOrigins: [],
    allowPrivateProvider: true,
    archive: {
      apiUrl: origin + "/api",
      apiToken: "archive-fixture-token",
      allowLoopbackHttp: true,
      intervalMs: 60_000,
    },
  };
  let runtime = createApp(options);
  let server = runtime.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  let base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = async (
    path: string,
    body?: unknown,
    token?: string,
    method?: string,
  ) => {
    const response = await fetch(base + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  const token = (
    await request("/api/admin/login", {
      email: options.adminEmail,
      password: options.adminPassword,
    })
  ).data.token;
  const settings = (await request("/api/admin/settings", undefined, token))
    .data;
  assert.equal(
    (
      await request(
        "/api/admin/settings",
        {
          ...settings,
          apiKey: "provider-fixture-key",
          baseUrl: origin + "/v1",
        },
        token,
        "PUT",
      )
    ).status,
    200,
  );
  return {
    dbPath,
    options,
    remoteRows,
    remoteCalls,
    providerTimes,
    request,
    token,
    flush: () => runtime.flushArchive(),
    stopRuntime: () => runtime.close(),
    setDecision: (value: string) => {
      decision = value;
    },
    setProviderFailure: () => {
      providerFailure = true;
    },
    setOffline: (value: boolean) => {
      offline = value;
    },
    setCreateMode: (value: string) => {
      createMode = value;
    },
    restart: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      runtime.close();
      runtime = createApp(options);
      server = runtime.app.listen(0, "127.0.0.1");
      await once(server, "listening");
      base = `http://127.0.0.1:${(server.address() as any).port}`;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        runtime.close();
      } finally {
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
function pending(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare("SELECT payload FROM architecture_chat_outbox")
      .all()
      .map((row) => JSON.parse(row.payload as string));
  } finally {
    db.close();
  }
}
const chat = (deviceId = "archive-device") => ({
  deviceId,
  messages: [
    { role: "user", content: "An older architecture question" },
    { role: "assistant", content: "An older answer" },
    { role: "user", content: "What about apartment daylight?" },
  ],
});

test("accepted chat durably queues exact event fields before success and syncs latest question", async () => {
  const h = await harness();
  try {
    const before = Date.now();
    const response = await h.request("/api/chat", chat());
    const after = Date.now();
    assert.equal(response.status, 200);
    assert.equal(response.data.reply, answer);
    const rows = pending(h.dbPath);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.deepEqual(
      Object.keys(row).sort(),
      [
        "event_id",
        "visitor_id",
        "question",
        "answer",
        "asked_at",
        "answered_at",
        "provider",
        "model",
      ].sort(),
    );
    assert.match(
      row.event_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(
      row.visitor_id,
      createHash("sha256").update("archive-device").digest("hex"),
    );
    assert.equal(row.question, "What about apartment daylight?");
    assert.equal(row.answer, answer);
    assert.equal(row.provider, "openai");
    assert.equal(row.model, "gpt-4o-mini");
    for (const field of ["asked_at", "answered_at"]) {
      assert.equal(new Date(row[field]).toISOString(), row[field]);
      assert.ok(
        Date.parse(row[field]) >= before && Date.parse(row[field]) <= after,
      );
    }
    assert.ok(row.asked_at <= row.answered_at);
    assert.ok(
      Date.parse(row.asked_at) <= h.providerTimes[0],
      "asked_at must precede classification",
    );
    assert.ok(
      Date.parse(row.answered_at) >= h.providerTimes[1],
      "answered_at must follow generation",
    );
    assert.equal(
      h.remoteCalls.length,
      0,
      "chat response must not await remote sync",
    );
    await h.flush();
    assert.deepEqual(h.remoteRows, [row]);
    assert.equal(pending(h.dbPath).length, 0);
    assert.match(h.remoteCalls[0].url, /^\/api\/aya_architecture_chats:list\?/);
    assert.equal(h.remoteCalls[1].url, "/api/aya_architecture_chats:create");
  } finally {
    await h.close();
  }
});

test("remote outage preserves successful chat and durable event through restart then recovery", async () => {
  const h = await harness();
  try {
    h.setOffline(true);
    assert.equal((await h.request("/api/chat", chat())).status, 200);
    const original = pending(h.dbPath);
    await assert.doesNotReject(h.flush());
    assert.deepEqual(pending(h.dbPath), original);
    await h.restart();
    assert.deepEqual(pending(h.dbPath), original);
    h.setOffline(false);
    await h.flush();
    assert.deepEqual(h.remoteRows, original);
    assert.equal(pending(h.dbPath).length, 0);
  } finally {
    await h.close();
  }
});

test("refusals, classifier failures, provider failures, invalid requests and admin tests never archive", async () => {
  const h = await harness();
  try {
    h.setDecision("BLOCK_EN");
    assert.equal((await h.request("/api/chat", chat())).data.blocked, true);
    h.setDecision("invalid classifier result");
    assert.equal((await h.request("/api/chat", chat())).status, 502);
    h.setDecision("classifier-error");
    assert.equal((await h.request("/api/chat", chat())).status, 502);
    h.setDecision("ALLOW");
    assert.equal((await h.request("/api/admin/test", {}, h.token)).status, 200);
    h.setProviderFailure();
    assert.equal((await h.request("/api/chat", chat())).status, 502);
    assert.equal((await h.request("/api/chat", {})).status, 400);
    await h.flush();
    assert.deepEqual(pending(h.dbPath), []);
    assert.deepEqual(h.remoteRows, []);
    assert.deepEqual(h.remoteCalls, []);
    assert.equal(
      (await h.request("/api/public/config")).data.archive,
      undefined,
    );
    assert.ok(
      !JSON.stringify(
        (await h.request("/api/admin/settings", undefined, h.token)).data,
      ).includes("archive-fixture-token"),
    );
  } finally {
    await h.close();
  }
});

for (const mode of ["duplicate", "lost-ack", "false-ack", "preexisting"]) {
  test(`archive reconciles ${mode} without losing events or duplicating records`, async () => {
    const h = await harness();
    try {
      await h.request("/api/chat", chat());
      const [event] = pending(h.dbPath);
      h.setCreateMode(mode);
      if (mode === "preexisting") h.remoteRows.push(event);
      await h.flush();
      if (mode === "false-ack") {
        assert.deepEqual(
          pending(h.dbPath),
          [event],
          "unverified success cannot discard durable event",
        );
        h.setCreateMode("normal");
        await h.flush();
      }
      assert.deepEqual(pending(h.dbPath), []);
      assert.deepEqual(h.remoteRows, [event]);
      await h.flush();
      assert.equal(h.remoteRows.length, 1);
      if (mode === "preexisting")
        assert.ok(h.remoteCalls.every((call) => call.method === "GET"));
    } finally {
      await h.close();
    }
  });
}

test("createApp.close cleans up archive before closing its shared database", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const h = await harness();
  try {
    await h.request("/api/chat", chat());
    const queued = pending(h.dbPath);
    h.stopRuntime();
    await h.flush();
    assert.deepEqual(pending(h.dbPath), queued);
    assert.equal(
      warning.mock.callCount(),
      0,
      "flush after app.close must be a no-op, not a closed DB failure",
    );
    assert.equal(h.remoteCalls.length, 0);
  } finally {
    await h.close();
  }
});

test("unknown create outcome survives restart and reconciles remotely committed event without another POST", async (t) => {
  t.mock.method(console, "warn", () => {});
  const h = await harness();
  try {
    await h.request("/api/chat", chat());
    const original = pending(h.dbPath);
    h.setCreateMode("lost-ack-unconfirmed");
    await h.flush();
    assert.deepEqual(pending(h.dbPath), original);
    assert.deepEqual(h.remoteRows, original);
    await h.restart();
    h.setOffline(false);
    await h.flush();
    assert.deepEqual(pending(h.dbPath), []);
    assert.deepEqual(h.remoteRows, original);
    assert.equal(
      h.remoteCalls.filter((call) => call.method === "POST").length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("failed durable enqueue cannot return chat success or retain a quota charge", async () => {
  const h = await harness();
  try {
    const db = new DatabaseSync(h.dbPath);
    db.exec("DROP TABLE architecture_chat_outbox");
    db.close();
    const response = await h.request("/api/chat", chat());
    assert.equal(response.status, 502);
    assert.equal(JSON.stringify(response.data).includes(answer), false);
    const read = new DatabaseSync(h.dbPath);
    try {
      assert.equal(read.prepare("SELECT used FROM quota").get()!.used, 0);
    } finally {
      read.close();
    }
    assert.equal(h.remoteCalls.length, 0);
  } finally {
    await h.close();
  }
});
