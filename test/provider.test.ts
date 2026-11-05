import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { complete } from "../src/provider.js";

test("provider applies an end-to-end request deadline", async () => {
  const fixture = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    await new Promise((r) => setTimeout(r, 150));
    res.end(
      JSON.stringify({ choices: [{ message: { content: "late fixture" } }] }),
    );
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  try {
    await assert.rejects(() =>
      complete(
        {
          provider: "openai",
          model: "fixture",
          baseUrl: `http://127.0.0.1:${(fixture.address() as any).port}/v1`,
          systemPrompt: "fixture",
          temperature: 0,
          maxTokens: 10,
        },
        "fixture-key",
        [{ role: "user", content: "fixture" }],
        true,
        30,
      ),
    );
  } finally {
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});

test("provider limits response body size to prevent unbounded upstream memory consumption", async () => {
  const fixture = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "x".repeat(1100000) } }],
      }),
    );
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  try {
    await assert.rejects(
      () =>
        complete(
          {
            provider: "openai-compatible",
            model: "fixture",
            baseUrl: `http://127.0.0.1:${(fixture.address() as any).port}/v1`,
            systemPrompt: "fixture",
            temperature: 0,
            maxTokens: 10,
          },
          "fixture-key",
          [{ role: "user", content: "fixture" }],
          true,
        ),
      /response too large/i,
    );
  } finally {
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});
