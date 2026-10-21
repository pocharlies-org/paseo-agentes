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

test("a line carries the directories that produced it, merged when two workspaces share the branch", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "paseo-agentes-cambios-"));
  execFileSync("git", ["init", "-b", "main", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/pocharlies-org/falso.git"]);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "x"), "");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "t"]);
  const { cambios } = await import("../server/cambios.ts");
  const lineas = await cambios([dir, dir]);
  assert.equal(lineas.length, 1);
  assert.deepEqual(lineas[0]!.rutas, [dir]);
  assert.equal(lineas[0]!.estado, "sinPr");
});
