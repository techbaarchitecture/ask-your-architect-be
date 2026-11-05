import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
const file = resolve(process.argv[2] ?? ".env");
if (!existsSync(file)) {
  const env = [
    `PORT=4100`,
    `HOST=127.0.0.1`,
    `ADMIN_EMAIL=admin-${randomBytes(6).toString("hex")}@ba.local`,
    `ADMIN_PASSWORD=${randomBytes(32).toString("base64url")}`,
    `ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`,
    "DATABASE_PATH=./data/app.sqlite",
    "ALLOWED_ORIGINS=http://localhost:5178",
    "ALLOW_PRIVATE_PROVIDER=false",
    "TRUST_PROXY=false",
    "",
  ].join("\n");
  writeFileSync(file, env, { mode: 0o600, flag: "wx" });
}
chmodSync(file, 0o600);
console.log(`Credentials file: ${file}`);
console.log(`Admin email: ${parse(readFileSync(file)).ADMIN_EMAIL}`);
