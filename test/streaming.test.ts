import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { complete } from "../src/provider.js";

async function fixture(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: any,
  ) => void | Promise<void>,
) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    await handler(req, res, JSON.parse(raw));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    settings: {
      provider: "openai-compatible",
      model: "fixture",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      systemPrompt: "Architecture fixture",
      temperature: 0.7,
      maxTokens: 128,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("OpenAI-compatible SDK consumes fragmented SSE without losing Vietnamese text", async () => {
  let request: any;
  const h = await fixture(async (_req, res, body) => {
    request = body;
    res.setHeader("content-type", "text/event-stream");
    const chunks = [
      {
        id: "fixture",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Kiến trúc " },
            finish_reason: null,
          },
        ],
      },
      {
        id: "fixture",
        choices: [
          {
            index: 0,
            delta: { content: "cho căn hộ 60 m²." },
            finish_reason: null,
          },
        ],
      },
      {
        id: "fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];
    const bytes = Buffer.from(
      chunks.map((x) => "data: " + JSON.stringify(x) + "\n\n").join("") +
        "data: [DONE]\n\n",
    );
    for (let index = 0; index < bytes.length; index += 7)
      res.write(bytes.subarray(index, index + 7));
    res.end();
  });
  try {
    const reply = await complete(
      h.settings,
      "fixture-key",
      [{ role: "user", content: "Gợi ý cải tạo" }],
      true,
    );
    assert.equal(reply, "Kiến trúc cho căn hộ 60 m².");
    assert.equal(request.stream, true);
    assert.equal(request.model, "fixture");
    assert.equal(request.messages[0].role, "system");
  } finally {
    await h.close();
  }
});
