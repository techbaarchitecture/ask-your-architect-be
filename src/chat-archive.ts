import type { DatabaseSync } from "node:sqlite";

export interface ChatArchiveOptions {
  apiUrl: string;
  apiToken: string;
  collection?: string;
  /** Explicit opt-in for isolated loopback HTTP fixtures, never public HTTP. */
  allowLoopbackHttp?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  batchSize?: number;
}
export interface ChatArchiveEvent {
  event_id: string;
  visitor_id: string;
  question: string;
  answer: string;
  asked_at: string;
  answered_at: string;
  provider: string;
  model: string;
}

function validateOptions(options: ChatArchiveOptions): ChatArchiveOptions {
  try {
    const url = new URL(options.apiUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          loopback &&
          options.allowLoopbackHttp === true
        )) ||
      url.username ||
      url.password ||
      /[?#]/.test(options.apiUrl) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(
        options.collection ?? "aya_architecture_chats",
      ) ||
      !options.apiToken.trim() ||
      /[\r\n\x00-\x1f\x7f]/.test(options.apiToken) ||
      !Number.isInteger(options.timeoutMs ?? 5000) ||
      (options.timeoutMs ?? 5000) < 10 ||
      (options.timeoutMs ?? 5000) > 30000 ||
      !Number.isInteger(options.intervalMs ?? 5000) ||
      (options.intervalMs ?? 5000) < 10 ||
      (options.intervalMs ?? 5000) > 300000 ||
      !Number.isInteger(options.batchSize ?? 20) ||
      (options.batchSize ?? 20) < 1 ||
      (options.batchSize ?? 20) > 100
    )
      throw new Error();
    return { ...options, apiUrl: url.href.replace(/\/+$/, "") };
  } catch {
    throw new Error("Invalid architecture archive configuration");
  }
}

/** Uses the application's SQLite database; never contains client-provided URLs. */
export class ChatArchive {
  private flight?: Promise<void>;
  private closed = false;
  private controller?: AbortController;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private db: DatabaseSync,
    private options: ChatArchiveOptions,
  ) {
    this.options = validateOptions(options);
    db.exec(
      "CREATE TABLE IF NOT EXISTS architecture_chat_outbox (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    );
    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.intervalMs ?? 5000);
    this.timer.unref();
  }

  enqueue(event: ChatArchiveEvent) {
    this.db
      .prepare(
        "INSERT INTO architecture_chat_outbox (event_id,payload) VALUES (?,?)",
      )
      .run(event.event_id, JSON.stringify(event));
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.flight)
      this.flight = this.flushBatch().finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.controller?.abort();
  }

  private async request(url: URL | string, body?: string): Promise<any> {
    if (this.closed) throw new Error("Archive closed");
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 5000,
    );
    try {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiToken}`,
          "Content-Type": "application/json",
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      if (body !== undefined || !response.ok) {
        await response.body?.cancel();
        if (!response.ok) throw new Error("Archive unavailable");
        return;
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
      this.controller = undefined;
    }
  }

  private async flushBatch() {
    try {
      const rows = this.db
        .prepare(
          "SELECT event_id,payload FROM architecture_chat_outbox ORDER BY rowid LIMIT ?",
        )
        .all(this.options.batchSize ?? 20);
      for (const row of rows) {
        if (this.closed) return;
        const collection = this.options.collection ?? "aya_architecture_chats";

        const list = new URL(`${this.options.apiUrl}/${collection}:list`);
        list.searchParams.set(
          "filter",
          JSON.stringify({ event_id: { $eq: row.event_id } }),
        );
        list.searchParams.set("pageSize", "1");
        const data = (await this.request(list)) as { data: ChatArchiveEvent[] };
        if (!data.data.some((event) => event.event_id === row.event_id)) {
          try {
            await this.request(
              `${this.options.apiUrl}/${collection}:create`,
              row.payload as string,
            );
          } catch {
            // A lost acknowledgement may still have committed the remote row.
          }
          const result = (await this.request(list)) as {
            data: ChatArchiveEvent[];
          };
          if (!result.data.some((event) => event.event_id === row.event_id))
            throw new Error("Archive not confirmed");
        }
        if (!this.closed)
          this.db
            .prepare("DELETE FROM architecture_chat_outbox WHERE event_id=?")
            .run(row.event_id);
      }
    } catch {
      // Never log upstream messages, URLs, credentials, questions or answers.
      if (!this.closed)
        console.warn(
          "Architecture archive sync deferred; queued data retained.",
        );
    }
  }
}
