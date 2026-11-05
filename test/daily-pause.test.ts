import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_PAUSE_MESSAGE,
  isDailyCapacityError,
} from "../src/daily-pause.js";

test("maps provider spend/key limits to a guest-safe daily pause", () => {
  assert.equal(isDailyCapacityError({ status: 402 }), true);
  assert.equal(
    isDailyCapacityError(new Error("Key has exceeded its spending limit")),
    true,
  );
  assert.equal(
    isDailyCapacityError({ statusCode: 403, message: "Insufficient credits" }),
    true,
  );
  assert.equal(isDailyCapacityError(new Error("Question limit reached")), false);
  assert.equal(isDailyCapacityError(new Error("Provider request failed")), false);
  assert.match(DAILY_PAUSE_MESSAGE, /come back tomorrow/i);
  assert.doesNotMatch(DAILY_PAUSE_MESSAGE, /\$|credit|budget|cap|money|spend/i);
});
