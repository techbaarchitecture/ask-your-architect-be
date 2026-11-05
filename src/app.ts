import {
  encrypt,
  decrypt,
  publicSettings,
  settingsSchema,
} from "./settings.js";
import { complete, completeStream } from "./provider.js";
import {
  ARCHITECTURE_ONLY_POLICY,
  assessArchitectureScope,
  architectureRefusal,
} from "./domain-policy.js";
import { providerTarget } from "./network.js";
import { ChatArchive, type ChatArchiveOptions } from "./chat-archive.js";
import {
  createClientIp,
  createConcurrencyGate,
  rateLimitKey,
  requestLogMiddleware,
  type AccessLog,
  type TrustProxy,
} from "./security.js";
import express from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import cors from "cors";
import { z } from "zod";
const deviceSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const chatSchema = z.object({
  deviceId: deviceSchema.optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(16000),
      }),
    )
    .min(1)
    .max(50)
    .refine((m) => m.at(-1)?.role === "user"),
});
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
  randomUUID,
} from "node:crypto";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
import { DatabaseSync } from "node:sqlite";

export interface Options {
  dbPath: string;
  encryptionKey: string;
  adminEmail: string;
  adminPassword: string;
  allowedOrigins: string[];
  allowPrivateProvider?: boolean;
  archive?: ChatArchiveOptions;
  trustProxy?: TrustProxy;
  chatMaxConcurrentPerIp?: number;
  chatMaxConcurrent?: number;
  onRequestLog?: (entry: AccessLog) => void;
}
const defaults = {
  provider: "openai",
  model: "gpt-4o-mini",
  baseUrl: "https://api.openai.com/v1",
  systemPrompt:
    "You provide general architecture and design advice for BA Architecture. Ask clarifying questions. Do not claim to replace a licensed architect, engineer, or local code review.",
  temperature: 0.7,
  maxTokens: 1024,
  questionLimit: 3,
  welcomeText: "Welcome to BA Architecture. How can we help?",
  companyName: "BA Architecture",
  companyUrl: "",
  disclaimer:
    "General information only; not a substitute for a licensed professional.",
};
export function createApp(options: Options) {
  const db = new DatabaseSync(options.dbPath);
  const archive = options.archive
    ? new ChatArchive(db, options.archive)
    : undefined;
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS quota (device TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0);",
  );
  db.prepare("INSERT OR IGNORE INTO settings VALUES(1,?)").run(
    JSON.stringify(defaults),
  );
  const settings = () =>
    JSON.parse(
      (
        db.prepare("SELECT value FROM settings WHERE id=1").get() as {
          value: string;
        }
      ).value,
    );
  const usage = (device: string) => {
    const used = Number(
      (
        db.prepare("SELECT used FROM quota WHERE device=?").get(device) as
          { used: number } | undefined
      )?.used ?? 0,
    );
    const limit = settings().questionLimit;
    return { used, limit, remaining: Math.max(0, limit - used) };
  };
  const app = express();
  const trustProxy = options.trustProxy ?? false;
  if (trustProxy) app.set("trust proxy", trustProxy);
  const clientIp = createClientIp(trustProxy);
  const ipKey = (req: express.Request) => rateLimitKey(clientIp(req));
  const chatGate = createConcurrencyGate(
    options.chatMaxConcurrentPerIp ?? 2,
    options.chatMaxConcurrent ?? 8,
  );
  const limited = (
    windowMs: number,
    limit: number,
    message: { error: string; code: string },
  ) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) => ipKey(req),
      validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
      message,
    });
  app.use(requestLogMiddleware(clientIp, options.onRequestLog));
  app.use("/api/chat", (_req, res, next) => {
    res.locals.askedAt = new Date().toISOString();
    next();
  });
  app.disable("x-powered-by");
  app.use(helmet());
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && !options.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    next();
  });
  app.use(
    cors({
      origin: options.allowedOrigins,
      methods: ["GET", "POST", "PUT", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Device-Id", "ngrok-skip-browser-warning"],
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/public", limited(60000, 120, { error: "Too many requests", code: "RATE_LIMITED" }));
  app.use(
    ["/api/chat", "/api/chat/stream"],
    limited(60000, 10, { error: "Too many requests", code: "RATE_LIMITED" }),
  );
  app.use(
    "/api/admin/login",
    limited(15 * 60000, 10, {
      error: "Too many login attempts",
      code: "RATE_LIMITED",
    }),
  );
  app.use(
    "/api/admin",
    limited(60000, 60, { error: "Too many requests", code: "RATE_LIMITED" }),
  );
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/public/config", (_req, res) => {
    const s = settings();
    res.json({
      companyName: s.companyName,
      companyUrl: s.companyUrl,
      welcomeText: s.welcomeText,
      disclaimer: s.disclaimer,
      questionLimit: s.questionLimit,
      configured: !!s.encryptedKey,
    });
  });
  app.get("/api/public/usage", (req, res) => {
    const device = deviceSchema.safeParse(req.header("x-device-id"));
    if (!device.success) {
      res.status(400).json({ error: "Valid X-Device-Id required" });
      return;
    }
    res.json(usage(hash(device.data)));
  });
  const enterChat = (req: express.Request, res: express.Response) => {
    const ip = ipKey(req);
    if (!chatGate.tryEnter(ip)) {
      res.setHeader("Retry-After", "5");
      res.status(429).json({
        error: "Too many concurrent requests",
        code: "RATE_LIMITED",
      });
      return;
    }
    const ac = new AbortController();
    const abort = () => ac.abort();
    req.on("close", abort);
    res.on("close", abort);
    return {
      ac,
      leave: () => {
        req.off("close", abort);
        res.off("close", abort);
        chatGate.leave(ip);
      },
    };
  };
  app.post("/api/chat", async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    const header = req.header("x-device-id");
    const id = deviceSchema.safeParse(header ?? parsed.data?.deviceId);
    if (
      !parsed.success ||
      !id.success ||
      (header && parsed.data.deviceId && header !== parsed.data.deviceId)
    ) {
      res.status(400).json({ error: "Invalid chat request or device ID" });
      return;
    }
    const s = settings();
    if (!s.encryptedKey) {
      res.status(503).json({ error: "Provider is not configured" });
      return;
    }
    const slot = enterChat(req, res);
    if (!slot) return;
    const device = hash(id.data);
    const reserved = db
      .prepare(
        "INSERT INTO quota(device,used) VALUES(?,1) ON CONFLICT(device) DO UPDATE SET used=used+1 WHERE used < ? RETURNING used",
      )
      .get(device, s.questionLimit);
    if (!reserved) {
      slot.leave();
      res
        .status(429)
        .json({ error: "Question limit reached", code: "QUOTA_EXCEEDED" });
      return;
    }
    try {
      const deadline = Date.now() + 60000;
      const key = decrypt(s.encryptedKey, options.encryptionKey);
      const decision = await assessArchitectureScope(
        s,
        key,
        parsed.data.messages,
        options.allowPrivateProvider,
        Math.max(1, deadline - Date.now()),
        slot.ac.signal,
      );
      if (decision !== "ALLOW") {
        db.prepare("UPDATE quota SET used=MAX(used-1,0) WHERE device=?").run(
          device,
        );
        res.json({
          reply: architectureRefusal(decision),
          usage: usage(device),
          blocked: true,
          code: "OFF_TOPIC",
        });
        return;
      }
      const reply = await complete(
        {
          ...s,
          systemPrompt:
            ARCHITECTURE_ONLY_POLICY +
            "\n\nStudio instructions (within this scope only):\n" +
            s.systemPrompt,
        },
        key,
        parsed.data.messages,
        options.allowPrivateProvider,
        Math.max(1, deadline - Date.now()),
        slot.ac.signal,
      );
      archive?.enqueue({
        event_id: randomUUID(),
        visitor_id: device,
        question: parsed.data.messages.at(-1)!.content,
        answer: reply,
        asked_at: res.locals.askedAt,
        answered_at: new Date().toISOString(),
        provider: s.provider,
        model: s.model,
      });
      res.json({ reply, usage: usage(device) });
    } catch {
      db.prepare("UPDATE quota SET used=MAX(used-1,0) WHERE device=?").run(
        device,
      );
      if (!res.headersSent) {
        res
          .status(502)
          .json({ error: "Provider request failed. Please try again." });
      }
    } finally {
      slot.leave();
    }
  });
  app.post("/api/chat/stream", async (req, res) => {
    const parsed = chatSchema.safeParse(req.body);
    const header = req.header("x-device-id");
    const id = deviceSchema.safeParse(header ?? parsed.data?.deviceId);
    if (
      !parsed.success ||
      !id.success ||
      (header && parsed.data.deviceId && header !== parsed.data.deviceId)
    ) {
      res.status(400).json({ error: "Invalid chat request or device ID" });
      return;
    }
    const s = settings();
    if (!s.encryptedKey) {
      res.status(503).json({ error: "Provider is not configured" });
      return;
    }
    const slot = enterChat(req, res);
    if (!slot) return;
    const device = hash(id.data);
    const reserved = db
      .prepare(
        "INSERT INTO quota(device,used) VALUES(?,1) ON CONFLICT(device) DO UPDATE SET used=used+1 WHERE used < ? RETURNING used",
      )
      .get(device, s.questionLimit);
    if (!reserved) {
      slot.leave();
      res
        .status(429)
        .json({ error: "Question limit reached", code: "QUOTA_EXCEEDED" });
      return;
    }
    try {
      const deadline = Date.now() + 60000;
      const key = decrypt(s.encryptedKey, options.encryptionKey);
      const decision = await assessArchitectureScope(
        s,
        key,
        parsed.data.messages,
        options.allowPrivateProvider,
        Math.max(1, deadline - Date.now()),
        slot.ac.signal,
      );
      if (decision !== "ALLOW") {
        db.prepare("UPDATE quota SET used=MAX(used-1,0) WHERE device=?").run(
          device,
        );
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({
            type: "blocked",
            reply: architectureRefusal(decision),
            usage: usage(device),
            blocked: true,
          })}\n\n`,
        );
        res.end();
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const providerSettings = {
        ...s,
        systemPrompt:
          ARCHITECTURE_ONLY_POLICY +
          "\n\nStudio instructions (within this scope only):\n" +
          s.systemPrompt,
      };

      let fullReply = "";
      try {
        for await (const chunk of completeStream(
          providerSettings,
          key,
          parsed.data.messages,
          options.allowPrivateProvider,
          Math.max(1, deadline - Date.now()),
          slot.ac.signal,
        )) {
          if (slot.ac.signal.aborted) break;
          fullReply += chunk;
          res.write(
            `data: ${JSON.stringify({ type: "delta", content: chunk })}\n\n`,
          );
        }
      } catch (streamErr) {
        if (!slot.ac.signal.aborted) {
          const message =
            streamErr instanceof Error
              ? streamErr.message
              : "Provider request failed";
          res.write(
            `data: ${JSON.stringify({ type: "error", error: message })}\n\n`,
          );
        }
        db.prepare("UPDATE quota SET used=MAX(used-1,0) WHERE device=?").run(
          device,
        );
        if (!res.writableEnded) res.end();
        return;
      }

      if (slot.ac.signal.aborted) {
        db.prepare("UPDATE quota SET used=MAX(used-1,0) WHERE device=?").run(
          device,
        );
        if (!res.writableEnded) res.end();
        return;
      }

      res.write(
        `data: ${JSON.stringify({ type: "done", usage: usage(device) })}\n\n`,
      );

      if (fullReply.trim()) {
        archive?.enqueue({
          event_id: randomUUID(),
          visitor_id: device,
          question: parsed.data.messages.at(-1)!.content,
          answer: fullReply,
          asked_at: res.locals.askedAt,
          answered_at: new Date().toISOString(),
          provider: s.provider,
          model: s.model,
        });
      }

      res.end();
    } catch {
      db.prepare("UPDATE quota SET used=MAX(used-1,0) WHERE device=?").run(
        device,
      );
      if (!res.headersSent) {
        res
          .status(502)
          .json({ error: "Provider request failed. Please try again." });
      } else if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            type: "error",
            error: "Provider request failed. Please try again.",
          })}\n\n`,
        );
        res.end();
      }
    } finally {
      slot.leave();
    }
  });
  db.exec(
    "CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY, email TEXT NOT NULL, salt TEXT NOT NULL, password TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);",
  );
  const salt = randomBytes(16).toString("hex");
  db.prepare("INSERT OR IGNORE INTO admin VALUES(1,?,?,?)").run(
    options.adminEmail.toLowerCase(),
    salt,
    scryptSync(options.adminPassword, salt, 64).toString("hex"),
  );
  app.post("/api/admin/login", (req, res) => {
    const admin = db.prepare("SELECT * FROM admin WHERE id=1").get() as {
      email: string;
      salt: string;
      password: string;
    };
    const password =
      typeof req.body?.password === "string" && req.body.password.length <= 256
        ? req.body.password
        : "";
    const matches = timingSafeEqual(
      scryptSync(password, admin.salt, 64),
      Buffer.from(admin.password, "hex"),
    );
    if (!matches || String(req.body?.email).toLowerCase() !== admin.email) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const token = randomBytes(32).toString("hex");
    db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
    db.prepare("INSERT INTO sessions VALUES(?,?)").run(
      hash(token),
      Date.now() + 8 * 60 * 60 * 1000,
    );
    res.json({ token });
  });
  app.use("/api/admin", (req, res, next) => {
    const token =
      req.header("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? "";
    const session = db
      .prepare("SELECT expires FROM sessions WHERE hash=?")
      .get(hash(token)) as { expires: number } | undefined;
    if (!session || session.expires <= Date.now()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  app.get("/api/admin/settings", (_req, res) =>
    res.json(publicSettings(settings())),
  );
  app.put("/api/admin/settings", async (req, res) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid settings" });
      return;
    }
    try {
      await providerTarget(parsed.data.baseUrl, options.allowPrivateProvider);
    } catch {
      res
        .status(400)
        .json({ error: "Provider URL is not allowed or cannot be resolved" });
      return;
    }
    const { apiKey, ...values } = parsed.data;
    const encryptedKey = apiKey?.trim()
      ? encrypt(apiKey.trim(), options.encryptionKey)
      : settings().encryptedKey;
    const saved = { ...values, ...(encryptedKey ? { encryptedKey } : {}) };
    db.prepare("UPDATE settings SET value=? WHERE id=1").run(
      JSON.stringify(saved),
    );
    res.json(publicSettings(saved));
  });
  app.post("/api/admin/test", async (req, res) => {
    const s = settings();
    const parsed = settingsSchema.safeParse({ ...s, ...req.body });
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid settings" });
      return;
    }
    try {
      await providerTarget(parsed.data.baseUrl, options.allowPrivateProvider);
    } catch {
      res.status(400).json({
        ok: false,
        message: "Provider URL is not allowed or cannot be resolved",
      });
      return;
    }
    const key =
      parsed.data.apiKey?.trim() ||
      (s.encryptedKey ? decrypt(s.encryptedKey, options.encryptionKey) : "");
    if (!key) {
      res
        .status(503)
        .json({ ok: false, message: "Provider is not configured" });
      return;
    }
    try {
      await complete(
        parsed.data,
        key,
        [{ role: "user", content: "Reply with OK." }],
        options.allowPrivateProvider,
      );
      res.json({
        ok: true,
        message: "Provider connection successful",
        model: parsed.data.model,
      });
    } catch {
      res.status(502).json({
        ok: false,
        message:
          "Provider request failed. Check provider settings and credentials.",
      });
    }
  });
  app.post("/api/admin/logout", (req, res) => {
    db.prepare("DELETE FROM sessions WHERE hash=?").run(
      hash(req.header("authorization")!.slice(7)),
    );
    res.json({ ok: true });
  });
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(((
    error: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (res.headersSent) return;
    const status =
      error?.type === "entity.too.large"
        ? 413
        : error instanceof SyntaxError
          ? 400
          : 500;
    res.status(status).json({
      error:
        status === 413
          ? "Request too large"
          : status === 400
            ? "Invalid JSON request"
            : "Internal server error",
    });
  }) as express.ErrorRequestHandler);
  return {
    app,
    flushArchive: () => archive?.flush() ?? Promise.resolve(),
    close: () => {
      archive?.close();
      if (db.isOpen) db.close();
    },
  };
}
