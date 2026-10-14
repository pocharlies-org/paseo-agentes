import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { vigilantes } from "../server/vigilantes.ts";

test("a task file held open by a live process counts for its session, and stops counting when the process ends", async () => {
  const raiz = mkdtempSync(join(tmpdir(), "vigilantes-"));
  const sesion = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const tareas = join(raiz, "claude-1000", "-home-x", sesion, "tasks");
  mkdirSync(tareas, { recursive: true });
  const fd = openSync(join(tareas, "b1x2y3z4.output"), "w");
  const hijo = spawn("sleep", ["30"], { stdio: ["ignore", fd, "ignore"] });
  closeSync(fd);
  try {
    assert.equal(vigilantes()[sesion], 1);
  } finally {
    const fin = new Promise((ok) => hijo.once("exit", ok));
    hijo.kill();
    await fin;
    rmSync(raiz, { recursive: true, force: true });
  }
  assert.equal(vigilantes()[sesion], undefined);
});
