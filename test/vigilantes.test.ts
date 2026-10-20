import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rutasDeLsof, vigilantes } from "../server/vigilantes.ts";

test("a task file held open by a live process counts for its session, and stops counting when the process ends", async () => {
  const raiz = mkdtempSync(join(tmpdir(), "vigilantes-"));
  const sesion = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const tareas = join(raiz, "claude-1000", "-home-x", sesion, "tasks");
  mkdirSync(tareas, { recursive: true });
  const fd = openSync(join(tareas, "b1x2y3z4.output"), "w");
  const hijo = spawn("sleep", ["30"], { stdio: ["ignore", fd, "ignore"] });
  closeSync(fd);
  try {
    assert.equal((await vigilantes({ sinCache: true }))[sesion], 1);
  } finally {
    const fin = new Promise((ok) => hijo.once("exit", ok));
    hijo.kill();
    await fin;
    rmSync(raiz, { recursive: true, force: true });
  }
  assert.equal((await vigilantes({ sinCache: true }))[sesion], undefined);
});

test("la caché reutiliza el resultado sin reescanear mientras sea reciente", async () => {
  const raiz = mkdtempSync(join(tmpdir(), "vigilantes-cache-"));
  const sesion = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const destino = join(raiz, "claude-1000", "-home-x", sesion, "tasks", "b1x2y3z4.output");
  const fd = join(raiz, "4242", "fd");
  mkdirSync(fd, { recursive: true });
  symlinkSync(destino, join(fd, "7"));
  const opciones = { proc: raiz };
  try {
    assert.equal((await vigilantes(opciones))[sesion], 1);
    rmSync(join(raiz, "4242"), { recursive: true, force: true }); // gone: a fresh scan would find nothing
    assert.equal((await vigilantes(opciones))[sesion], 1); // still the cached result, not a rescan
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test("a missing /proc falls back without throwing", async () => {
  const resultado = await vigilantes({ proc: "/no/such/proc" });
  assert.equal(typeof resultado, "object");
});

test("a missing or failing lsof gives {} and never throws", async () => {
  assert.deepEqual(await vigilantes({ proc: "/no/such/proc", lsof: "/no/such/lsof" }), {});
  assert.deepEqual(await vigilantes({ proc: "/no/such/proc", lsof: "false" }), {});
  assert.deepEqual(await vigilantes({ proc: "/no/such/proc", uid: undefined }), {});
});

test("lsof -F n output is parsed to paths, ignoring pid lines", () => {
  const sesion = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const salida = `p101\nn/dev/null\nn/private/tmp/claude-501/-Users-x/${sesion}/tasks/b1.output\np102\nn/private/tmp/claude-501/-Users-x/${sesion}/tasks/b1.output\nn->0x1234\n`;
  const rutas = rutasDeLsof(salida);
  assert.equal(rutas.length, 4);
  assert.equal(rutas[1], `/private/tmp/claude-501/-Users-x/${sesion}/tasks/b1.output`);
});
