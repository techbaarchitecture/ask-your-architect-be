export const DAILY_PAUSE_CODE = "DAILY_PAUSE";
export const DAILY_PAUSE_MESSAGE =
  "We've paused new questions for today. Please come back tomorrow.";

export function isDailyCapacityError(err: unknown): boolean {
  let status: number | undefined;
  const parts: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (value == null || depth > 5) return;
    if (typeof value === "number") {
      if (value >= 400 && value < 600) status ??= value;
      return;
    }
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (value instanceof Error) {
      parts.push(value.message, value.name);
      walk((value as Error & { cause?: unknown }).cause, depth + 1);
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of [
        "status",
        "statusCode",
        "statusText",
        "code",
        "message",
        "error",
        "type",
        "reason",
      ]) {
        if (key in record) walk(record[key], depth + 1);
      }
    }
  };
  walk(err, 0);
  const blob = parts.join(" ").toLowerCase();
  if (status === 402) return true;
  return /key limit|credit limit|spending limit|insufficient credits|payment required|usage limit exceeded|budget (limit|exceeded)|has exceeded its (spend|limit)/.test(
    blob,
  );
}
