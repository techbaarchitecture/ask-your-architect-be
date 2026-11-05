import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  ChatArchive,
  type ChatArchiveOptions,
  type ChatArchiveEvent,
} from "../src/chat-archive.js";

const valid: ChatArchiveOptions = {
  apiUrl: "https://dev.baarchitecture.cloud/api",
  apiToken: "fixture-private-token",
};

test("archive validates server-only URL, collection, credential and worker bounds without revealing values", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const invalid: Partial<ChatArchiveOptions>[] = [
      { apiUrl: "http://public.example/api" },
      { apiUrl: "http://127.0.0.1/api" },
      { apiUrl: "http://127.0.0.1.evil.example/api", allowLoopbackHttp: true },
      { apiUrl: "ftp://example.com/api" },
      { apiUrl: "https://username:password@example.com/api" },
      { apiUrl: "https://example.com/api?secret=value" },
      { apiUrl: "https://example.com/api#secret" },
      { apiUrl: "https://example.com/api?" },
      { apiUrl: "not a URL" },
      { collection: "../settings" },
      { collection: "foo:create" },
      { collection: "" },
      { apiToken: "" },
      { apiToken: "key\nunsafe" },
      { timeoutMs: 0 },
      { timeoutMs: Infinity },
      { intervalMs: 0 },
      { batchSize: -1 },
      { batchSize: 1.5 },
    ];
    for (const patch of invalid) {
      assert.throws(
        () => new ChatArchive(db, { ...valid, ...patch }),
        (error: any) => {
          assert.equal(
            error.message,
            "Invalid architecture archive configuration",
          );
          return true;
        },
        JSON.stringify(Object.keys(patch)),
      );
    }
  } finally {
    db.close();
  }
});

const event = (): ChatArchiveEvent => ({
  event_id: randomUUID(),
  visitor_id: "hashed-device",
  question: "private-question",
  answer: "private-answer",
  asked_at: "2026-10-25T00:00:00.000Z",
  answered_at: "2026-10-25T00:00:01.000Z",
  provider: "openai",
  model: "fixture",
});

async function worker(
  options: Partial<ChatArchiveOptions> = {},
  mode = "normal",
) {
  const db = new DatabaseSync(":memory:");
  const rows: ChatArchiveEvent[] = [];
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    if (mode === "no-headers") return;
    if (mode === "body-stall") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":');
      return;
    }
    if (mode === "redirect" && !req.url?.startsWith("/leak")) {
      res.writeHead(302, { location: "/leak" }).end();
      return;
    }
    await delay(5);
    let body = "";
    for await (const part of req) body += part;
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      const id = JSON.parse(
        new URL(req.url!, "http://fixture").searchParams.get("filter")!,
      ).event_id.$eq;
      res.end(
        JSON.stringify({ data: rows.filter((row) => row.event_id === id) }),
      );
    } else {
      rows.push(JSON.parse(body));
      res.end(JSON.stringify({ data: rows.at(-1) }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const archive = new ChatArchive(db, {
    apiUrl: `http://127.0.0.1:${(server.address() as any).port}/api/`,
    apiToken: "fixture-token",
    allowLoopbackHttp: true,
    intervalMs: 60_000,
    ...options,
  });
  return {
    db,
    archive,
    rows,
    calls: () => calls,
    close: async () => {
      archive.close();
      if (db.isOpen) db.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("concurrent flush calls share one flight with a bounded batch", async () => {
  const h = await worker({ batchSize: 2 });
  try {
    const events = [event(), event(), event()];
    events.forEach((row) => h.archive.enqueue(row));
    await Promise.all([
      h.archive.flush(),
      h.archive.flush(),
      h.archive.flush(),
    ]);
    assert.deepEqual(h.rows, events.slice(0, 2));
    assert.equal(
      h.db.prepare("SELECT COUNT(*) AS n FROM architecture_chat_outbox").get()!
        .n,
      1,
    );
    await h.archive.flush();
    assert.deepEqual(h.rows, events);
  } finally {
    await h.close();
  }
});

test("background timer drains events and close is repeatable and stops future work", async () => {
  const h = await worker({ intervalMs: 20 });
  try {
    const row = event();
    h.archive.enqueue(row);
    const deadline = Date.now() + 1000;
    while (h.rows.length === 0 && Date.now() < deadline) await delay(10);
    assert.deepEqual(h.rows, [row], "timer should drain without manual flush");
    await h.archive.flush();
    h.archive.close();
    h.archive.close();
    const calls = h.calls();
    await h.archive.flush();
    await delay(80);
    assert.equal(h.calls(), calls, "closed worker must not make requests");
  } finally {
    await h.close();
  }
});

for (const mode of ["no-headers", "body-stall"]) {
  test(`archive deadline bounds ${mode} and retains data with sanitized logging`, async (t) => {
    const warning = t.mock.method(console, "warn", () => {});
    const h = await worker({ timeoutMs: 30 }, mode);
    try {
      h.archive.enqueue(event());
      const completed = await Promise.race([
        h.archive.flush().then(() => true),
        delay(500).then(() => false),
      ]);
      assert.equal(
        completed,
        true,
        "entire HTTP request including body must time out",
      );
      assert.equal(
        h.db
          .prepare("SELECT COUNT(*) AS n FROM architecture_chat_outbox")
          .get()!.n,
        1,
      );
      assert.equal(warning.mock.callCount(), 1);
      assert.deepEqual(warning.mock.calls[0].arguments, [
        "Architecture archive sync deferred; queued data retained.",
      ]);
    } finally {
      await h.close();
    }
  });
}

test("archive refuses redirects instead of forwarding authorization or dropping queued events", async (t) => {
  t.mock.method(console, "warn", () => {});
  const h = await worker({}, "redirect");
  try {
    h.archive.enqueue(event());
    await h.archive.flush();
    assert.equal(h.calls(), 1, "must not follow redirect to /leak");
    assert.equal(
      h.db.prepare("SELECT COUNT(*) AS n FROM architecture_chat_outbox").get()!
        .n,
      1,
    );
  } finally {
    await h.close();
  }
});

test("close aborts in-flight requests before SQLite closes and does not log shutdown as failure", async (t) => {
  const warning = t.mock.method(console, "warn", () => {});
  const h = await worker({ timeoutMs: 1000 }, "body-stall");
  try {
    h.archive.enqueue(event());
    const flight = h.archive.flush();
    while (h.calls() === 0) await delay(1);
    h.archive.close();
    h.db.close();
    assert.equal(
      await Promise.race([
        flight.then(() => true),
        delay(100).then(() => false),
      ]),
      true,
    );
    await h.archive.flush();
    assert.equal(h.calls(), 1);
    assert.equal(warning.mock.callCount(), 0);
  } finally {
    await h.close();
  }
});
