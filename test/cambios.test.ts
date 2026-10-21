import assert from "node:assert/strict";
import { test } from "node:test";
import { estadoRollup } from "../server/cambios.ts";

test("the check rollup reads as the block's states, with the same rules as cambios.sh", () => {
  assert.deepEqual(estadoRollup([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]), { estado: "verde", ok: 2, total: 2 });
  assert.deepEqual(estadoRollup([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }]), { estado: "roja", ok: 1, total: 2 });
  assert.deepEqual(estadoRollup([{ state: "PENDING" }, { conclusion: "SUCCESS" }]), { estado: "marcha", ok: 1, total: 2 });
  assert.deepEqual(estadoRollup([]), { estado: "sinChecks", ok: 0, total: 0 });
  assert.deepEqual(estadoRollup(undefined), { estado: "sinChecks", ok: 0, total: 0 });
});

test("a directory that is not a repo gives no line (git fails, and gh is never asked)", async () => {
  const { cambios } = await import("../server/cambios.ts");
  assert.deepEqual(await cambios(["/no/existe-paseo-agentes"]), []);
});
