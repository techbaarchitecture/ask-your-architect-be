import { config } from "dotenv";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { createApp } from "./app.js";
import { parseTrustProxy } from "./security.js";

process.umask(0o077);
config({ path: process.env.ENV_FILE ?? ".env", quiet: true });
const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(4100),
  HOST: z.string().default("127.0.0.1"),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(16).max(256),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  DATABASE_PATH: z.string().min(1).default("./data/app.sqlite"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5178"),
  ALLOW_PRIVATE_PROVIDER: z.enum(["true", "false"]).default("false"),
  TRUST_PROXY: z.string().optional(),
  CHAT_MAX_CONCURRENT: z.coerce.number().int().min(1).max(64).default(8),
  CHAT_MAX_CONCURRENT_PER_IP: z.coerce.number().int().min(1).max(16).default(2),
  NOCOBASE_API_URL: z.string().optional(),
  NOCOBASE_API_TOKEN: z.string().optional(),
  NOCOBASE_CHAT_COLLECTION: z.string().optional(),
});
const env = schema.safeParse(process.env);
if (!env.success) {
  console.error(
    "Invalid server configuration. Run npm run setup and check .env.",
  );
  process.exit(1);
}
const e = env.data;
const origins = e.ALLOWED_ORIGINS.split(",")
  .map((v) => v.trim())
  .filter(Boolean);
if (
  origins.some((origin) => {
    try {
      const url = new URL(origin);
      return (
        !["http:", "https:"].includes(url.protocol) || url.origin !== origin
      );
    } catch {
      return true;
    }
  })
) {
  console.error("ALLOWED_ORIGINS must contain exact HTTP(S) origins.");
  process.exit(1);
}
const dbPath = resolve(e.DATABASE_PATH);
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
let trustProxy: ReturnType<typeof parseTrustProxy> = false;
try {
  trustProxy = parseTrustProxy(e.TRUST_PROXY);
} catch {
  console.error(
    "Invalid server configuration. Run npm run setup and check .env.",
  );
  process.exit(1);
}
let runtime: ReturnType<typeof createApp>;
try {
  runtime = createApp({
    dbPath,
    encryptionKey: e.ENCRYPTION_KEY,
    adminEmail: e.ADMIN_EMAIL,
    adminPassword: e.ADMIN_PASSWORD,
    allowedOrigins: origins,
    allowPrivateProvider: e.ALLOW_PRIVATE_PROVIDER === "true",
    trustProxy,
    chatMaxConcurrent: e.CHAT_MAX_CONCURRENT,
    chatMaxConcurrentPerIp: e.CHAT_MAX_CONCURRENT_PER_IP,
    onRequestLog: (entry) => console.log(JSON.stringify(entry)),
    archive:
      e.NOCOBASE_API_URL || e.NOCOBASE_API_TOKEN
        ? {
            apiUrl: e.NOCOBASE_API_URL ?? "",
            apiToken: e.NOCOBASE_API_TOKEN ?? "",
            collection: e.NOCOBASE_CHAT_COLLECTION || undefined,
          }
        : undefined,
  });
} catch {
  console.error(
    "Invalid server configuration. Run npm run setup and check .env.",
  );
  process.exit(1);
}
const server = runtime.app.listen(e.PORT, e.HOST, () => {
  const address = server.address();
  console.log(
    `API listening at http://${e.HOST}:${typeof address === "object" && address ? address.port : e.PORT}`,
  );
});
server.requestTimeout = 70000;
server.headersTimeout = 10000;
server.on("error", () => {
  console.error("Unable to bind API listener. Check HOST and PORT.");
  runtime.close();
  process.exit(1);
});
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      runtime.close();
      process.exit(0);
    });
  });
