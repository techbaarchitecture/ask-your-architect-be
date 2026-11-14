import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as policy from "../src/domain-policy.js";

test("policy version is a stable SHA256 identity of the exact classifier instructions", () => {
  const p = policy as any;
  assert.equal(typeof p.scopePolicyVersion, "function");
  assert.equal(p.SCOPE_POLICY_VERSION, p.scopePolicyVersion());
  assert.equal(
    p.SCOPE_POLICY_VERSION,
    "sha256:" + createHash("sha256").update(p.CLASSIFIER_POLICY).digest("hex"),
  );
  assert.equal(
    p.scopePolicyVersion(p.CLASSIFIER_POLICY),
    p.SCOPE_POLICY_VERSION,
  );
  assert.notEqual(
    p.scopePolicyVersion(p.CLASSIFIER_POLICY + "\n"),
    p.SCOPE_POLICY_VERSION,
  );
});
