import assert from "node:assert/strict";
import test from "node:test";

import { normalizePlanPathArg, withRalpixErrorHandling } from "./index.js";

void test("normalizePlanPathArg strips a leading file-mention marker", () => {
  assert.equal(
    normalizePlanPathArg("@docs/plans/my-feature.md"),
    "docs/plans/my-feature.md",
  );
});

void test("normalizePlanPathArg preserves normal paths", () => {
  assert.equal(
    normalizePlanPathArg("docs/plans/my-feature.md"),
    "docs/plans/my-feature.md",
  );
});

void test("normalizePlanPathArg preserves scoped names that are not paths", () => {
  assert.equal(
    normalizePlanPathArg("@scope/package"),
    "@scope/package",
  );
});

void test("withRalpixErrorHandling surfaces thrown errors via notify", async () => {
  const notices: string[] = [];

  await withRalpixErrorHandling(
    async () => await Promise.reject(new Error("boom")),
    (message, level) => {
      notices.push(`${level}:${message}`);
    },
  );

  assert.deepEqual(notices, ["error:ralpix error: boom"]);
});

void test("withRalpixErrorHandling leaves successful runs untouched", async () => {
  const notices: string[] = [];

  await withRalpixErrorHandling(
    async () => await Promise.resolve(),
    (message, level) => {
      notices.push(`${level}:${message}`);
    },
  );

  assert.deepEqual(notices, []);
});
