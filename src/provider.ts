import { providerDispatcher } from "./network.js";
import { deadlineSignal } from "./security.js";
import { fetch } from "undici";
import { streamText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
export interface Message {
  role: "user" | "assistant";
  content: string;
}
export interface ProviderSettings {
  provider: string;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}
export async function complete(
  s: ProviderSettings,
  key: string,
  messages: Message[],
  allowPrivate = false,
  timeoutMs = 60000,
  abortSignal?: AbortSignal,
): Promise<string> {
  let path = "/chat/completions";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  let body: unknown;
  if (s.provider === "anthropic") {
    path = "/messages";
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: s.model,
      system: s.systemPrompt,
      messages,
      max_tokens: s.maxTokens,
      temperature: s.temperature,
    };
  } else if (s.provider === "gemini") {
    path = `/models/${encodeURIComponent(s.model)}:generateContent`;
    headers["x-goog-api-key"] = key;
    body = {
      systemInstruction: { parts: [{ text: s.systemPrompt }] },
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature: s.temperature,
        maxOutputTokens: s.maxTokens,
      },
    };
  } else {
    headers.authorization = `Bearer ${key}`;
    body = {
      model: s.model,
      messages: [{ role: "system", content: s.systemPrompt }, ...messages],
      temperature: s.temperature,
      max_tokens: s.maxTokens,
    };
  }
  const signal = deadlineSignal(timeoutMs, abortSignal);
  const dispatcher = await providerDispatcher(s.baseUrl, allowPrivate, signal);
  try {
    if (s.provider === "openai-compatible") {
      let streamError: unknown;
      const endpoint = s.baseUrl.replace(/\/$/, "") + "/chat/completions";
      const provider = createOpenAICompatible({
        name: "architect",
        baseURL: s.baseUrl,
        apiKey: key,
        fetch: async (input, init) => {
          const target =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (target !== endpoint || typeof init?.body !== "string")
            throw new Error("Unexpected provider request");
          const response = await fetch(target, {
            dispatcher,
            method: "POST",
            headers: Object.fromEntries(new Headers(init.headers).entries()),
            body: init.body,
            signal,
            redirect: "error",
          });
          let size = 0;
          const source =
            response.body as unknown as ReadableStream<Uint8Array> | null;
          const limited = source?.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                size += chunk.byteLength;
                if (size > 1024 * 1024) {
                  streamError = new Error("Provider response too large");
                  throw streamError;
                }
                controller.enqueue(chunk);
              },
            }),
          );
          return new Response(limited as ReadableStream<Uint8Array> | null, {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
          });
        },
      });
      const result = streamText({
        model: provider.chatModel(s.model),
        system: s.systemPrompt,
        messages,
        temperature: s.temperature,
        maxOutputTokens: s.maxTokens,
        maxRetries: 0,
        abortSignal: signal,
        onError: ({ error }) => {
          streamError = error;
        },
      });
      let text: string;
      try {
        text = await result.text;
      } catch (error) {
        throw streamError ?? error;
      }
      if (streamError) throw streamError;
      if (!text.trim()) throw new Error("Empty provider response");
      return text;
    }
    const response = await fetch(s.baseUrl.replace(/\/$/, "") + path, {
      dispatcher,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Provider request failed");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 1024 * 1024) throw new Error("Provider response too large");
        chunks.push(chunk);
      }
    }
    const data: any = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const text =
      s.provider === "anthropic"
        ? data.content
            ?.filter((x: any) => x.type === "text")
            .map((x: any) => x.text)
            .join("\n")
        : s.provider === "gemini"
          ? data.candidates?.[0]?.content?.parts
              ?.map((x: any) => x.text ?? "")
              .join("\n")
          : data.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim())
      throw new Error("Empty provider response");
    return text;
  } finally {
    await dispatcher.close();
  }
}

export async function* completeStream(
  s: ProviderSettings,
  key: string,
  messages: Message[],
  allowPrivate = false,
  timeoutMs = 60000,
  abortSignal?: AbortSignal,
): AsyncGenerator<string, void, undefined> {
  const signal = deadlineSignal(timeoutMs, abortSignal);
  const dispatcher = await providerDispatcher(s.baseUrl, allowPrivate, signal);
  try {
    if (s.provider === "openai-compatible") {
      let streamError: unknown;
      const endpoint = s.baseUrl.replace(/\/$/, "") + "/chat/completions";
      const provider = createOpenAICompatible({
        name: "architect",
        baseURL: s.baseUrl,
        apiKey: key,
        fetch: async (input, init) => {
          const target =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (target !== endpoint || typeof init?.body !== "string")
            throw new Error("Unexpected provider request");
          const response = await fetch(target, {
            dispatcher,
            method: "POST",
            headers: Object.fromEntries(new Headers(init.headers).entries()),
            body: init.body,
            signal,
            redirect: "error",
          });
          let size = 0;
          const source =
            response.body as unknown as ReadableStream<Uint8Array> | null;
          const limited = source?.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                size += chunk.byteLength;
                if (size > 1024 * 1024) {
                  streamError = new Error("Provider response too large");
                  throw streamError;
                }
                controller.enqueue(chunk);
              },
            }),
          );
          return new Response(limited as ReadableStream<Uint8Array> | null, {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
          });
        },
      });
      const result = streamText({
        model: provider.chatModel(s.model),
        system: s.systemPrompt,
        messages,
        temperature: s.temperature,
        maxOutputTokens: s.maxTokens,
        maxRetries: 0,
        abortSignal: signal,
        onError: ({ error }) => {
          streamError = error;
        },
      });
      try {
        for await (const chunk of result.textStream) {
          if (streamError) throw streamError;
          if (chunk) yield chunk;
        }
      } catch (error) {
        throw streamError ?? error;
      }
      if (streamError) throw streamError;
      return;
    }

    // Native providers: streaming via SSE
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    let path = "/chat/completions";
    let body: unknown;

    if (s.provider === "anthropic") {
      path = "/messages";
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model: s.model,
        system: s.systemPrompt,
        messages,
        max_tokens: s.maxTokens,
        temperature: s.temperature,
        stream: true,
      };
    } else if (s.provider === "gemini") {
      // Gemini REST doesn't have good SSE streaming — yield full response
      path = `/models/${encodeURIComponent(s.model)}:generateContent`;
      headers["x-goog-api-key"] = key;
      body = {
        systemInstruction: { parts: [{ text: s.systemPrompt }] },
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: {
          temperature: s.temperature,
          maxOutputTokens: s.maxTokens,
        },
      };
    } else {
      // openai native
      headers.authorization = `Bearer ${key}`;
      body = {
        model: s.model,
        messages: [{ role: "system", content: s.systemPrompt }, ...messages],
        temperature: s.temperature,
        max_tokens: s.maxTokens,
        stream: true,
      };
    }

    const response = await fetch(s.baseUrl.replace(/\/$/, "") + path, {
      dispatcher,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Provider request failed");
    }

    if (s.provider === "gemini") {
      // Non-streaming: collect and yield entire response at once
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 1024 * 1024)
            throw new Error("Provider response too large");
          chunks.push(chunk);
        }
      }
      const data: any = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const text = data.candidates?.[0]?.content?.parts
        ?.map((x: any) => x.text ?? "")
        .join("\n");
      if (typeof text !== "string" || !text.trim())
        throw new Error("Empty provider response");
      yield text;
      return;
    }

    // SSE parsing for openai / anthropic streams
    let size = 0;
    let buffer = "";
    if (!response.body) throw new Error("Empty provider response");
    for await (const raw of response.body) {
      size += raw.byteLength;
      if (size > 1024 * 1024) throw new Error("Provider response too large");
      buffer += Buffer.from(raw).toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        if (s.provider === "anthropic") {
          if (parsed.type === "content_block_delta") {
            const delta = parsed.delta?.text;
            if (delta) yield delta;
          } else if (parsed.type === "message_stop") {
            return;
          } else if (parsed.type === "error") {
            throw new Error(
              parsed.error?.message ?? "Anthropic stream error",
            );
          }
        } else {
          // openai
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
          if (parsed.choices?.[0]?.finish_reason) return;
        }
      }
    }
  } finally {
    await dispatcher.close();
  }
}
