import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
const quickQuestionSchema = z.object({
  title: z.string().trim().min(1).max(80),
  question: z.string().trim().min(1).max(500),
});
export const settingsSchema = z.object({
  provider: z.enum(["openai", "openai-compatible", "anthropic", "gemini"]),
  model: z.string().trim().min(1).max(200),
  baseUrl: z.url().max(2048),
  systemPrompt: z.string().max(16000),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(32768),
  questionLimit: z.number().int().min(1).max(10000),
  welcomeText: z.string().max(4000),
  companyName: z.string().trim().min(1).max(200),
  companyUrl: z.union([
    z.literal(""),
    z.url().refine((u) => /^https?:/.test(u)),
  ]),
  disclaimer: z.string().max(4000),
  apiKey: z.string().max(4096).optional(),
  quickQuestions: z.object({
    en: z.array(quickQuestionSchema).length(4),
    es: z.array(quickQuestionSchema).length(4),
    zh: z.array(quickQuestionSchema).length(4),
    vi: z.array(quickQuestionSchema).length(4),
  }),
});
export function encrypt(value: string, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    data.toString("hex"),
  ].join(".");
}
export function decrypt(value: string, key: string) {
  const [iv, tag, data] = value.split(".");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    Buffer.from(iv, "hex"),
  );
  cipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    cipher.update(Buffer.from(data, "hex")),
    cipher.final(),
  ]).toString("utf8");
}
export function publicSettings(s: Record<string, unknown>) {
  const { encryptedKey, ...safe } = s;
  return {
    ...safe,
    apiKeyConfigured: !!encryptedKey,
    apiKeyHint: encryptedKey ? "••••••••" : "",
  };
}
