import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { contexto, tareas, tokensDeContexto } from "../server/contexto.ts";

const sesion = "0f0e0d0c-0b0a-4908-8706-050403020100";

test("the task list is read ordered and with its statuses; a session without directory has none", async () => {
  const raiz = mkdtempSync(join(mkdtempSync("/tmp/"), "tasks-"));
  try {
    mkdirSync(join(raiz, sesion), { recursive: true });
    writeFileSync(join(raiz, sesion, "2.json"), JSON.stringify({ subject: "Segunda", status: "in_progress" }));
    writeFileSync(join(raiz, sesion, "1.json"), JSON.stringify({ subject: "Primera", status: "completed" }));
    writeFileSync(join(raiz, sesion, "3.json"), "{ roto");
    writeFileSync(join(raiz, sesion, "4.json"), JSON.stringify({ subject: "Sin estado válido", status: "raro" }));
    const leidas = await tareas(sesion, raiz);
    assert.deepEqual(leidas, [
      { subject: "Primera", status: "completed" },
      { subject: "Segunda", status: "in_progress" },
    ]);
    assert.deepEqual(await tareas("no-existe", raiz), []);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test("the last usage of the transcript is the context used; a torn last line keeps looking upward", () => {
  const suelta = [
    JSON.stringify({ message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } } }),
    JSON.stringify({ message: { usage: { input_tokens: 7, cache_read_input_tokens: 1000 } } }),
    '{"message": {"usage": {"input_tokens": 9',
  ].join("\n");
  assert.equal(tokensDeContexto(suelta), 1007);
  assert.equal(tokensDeContexto(JSON.stringify({ type: "user" })), null);
});

test("the transcript is found by the escaped cwd; a missing one is null, never a throw", async () => {
  const raiz = mkdtempSync(join(mkdtempSync("/tmp/"), "projects-"));
  const cwd = "/home/x/proyecto";
  try {
    mkdirSync(join(raiz, cwd.replace(/\//g, "-")), { recursive: true });
    writeFileSync(
      join(raiz, cwd.replace(/\//g, "-"), `${sesion}.jsonl`),
      JSON.stringify({ message: { usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } }) + "\n",
    );
    assert.equal(await contexto(sesion, cwd, raiz), 6);
    assert.equal(await contexto(sesion, "/home/x/otro", raiz), null);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});
