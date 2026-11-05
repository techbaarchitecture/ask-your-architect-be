import type { Request, RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { ipKeyGenerator } from "express-rate-limit";
import ipaddr from "ipaddr.js";

export type TrustProxy = false | number | string | string[];

export type AccessLog = {
  ts: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  ip: string;
};

export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = raw?.trim();
  if (!value || value === "false" || value === "0") return false;
  if (value === "true")
    throw new Error("TRUST_PROXY=true is not allowed; set hop count or proxy IPs");
  if (/^\d+$/.test(value)) return Number(value);
  if (value.includes(","))
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  return value;
}

export function parseIp(value: string | undefined): string | undefined {
  if (!value) return;
  try {
    return ipaddr.process(value.trim()).toString();
  } catch {
    return;
  }
}

export function createClientIp(trustProxy: TrustProxy) {
  return (req: Request) => {
    if (!trustProxy) return req.socket.remoteAddress ?? "unknown";
    return (
      parseIp(req.header("cf-connecting-ip")) ??
      req.ip ??
      req.socket.remoteAddress ??
      "unknown"
    );
  };
}

export function rateLimitKey(ip: string) {
  try {
    return ipKeyGenerator(ip);
  } catch {
    return ip;
  }
}

export function requestIdFrom(req: Request) {
  const incoming = req.header("x-request-id");
  return incoming &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      incoming,
    )
    ? incoming
    : randomUUID();
}

export function createConcurrencyGate(maxPerIp: number, maxGlobal: number) {
  const perIp = new Map<string, number>();
  let global = 0;
  return {
    tryEnter(ip: string) {
      if (global >= maxGlobal) return false;
      const current = perIp.get(ip) ?? 0;
      if (current >= maxPerIp) return false;
      perIp.set(ip, current + 1);
      global += 1;
      return true;
    },
    leave(ip: string) {
      global = Math.max(0, global - 1);
      const current = (perIp.get(ip) ?? 1) - 1;
      if (current <= 0) perIp.delete(ip);
      else perIp.set(ip, current);
    },
  };
}

export function requestLogMiddleware(
  clientIp: (req: Request) => string,
  onRequestLog?: (entry: AccessLog) => void,
): RequestHandler {
  return (req, res, next) => {
    const requestId = requestIdFrom(req);
    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    const started = Date.now();
    res.on("finish", () => {
      if (!onRequestLog || req.path === "/api/health") return;
      onRequestLog({
        ts: new Date().toISOString(),
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        ip: rateLimitKey(clientIp(req)),
      });
    });
    next();
  };
}

export function deadlineSignal(timeoutMs: number, abortSignal?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!abortSignal) return timeout;
  return AbortSignal.any([timeout, abortSignal]);
}
