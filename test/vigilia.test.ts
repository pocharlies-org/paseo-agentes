import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { vigilia } from "../server/vigilia.ts";

const A = "0f0e0d0c-0b0a-4908-8706-050403020100";
const B = "1f0e0d0c-0b0a-4908-8706-050403020100";
const linea = (tokens: number) => JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: tokens } } }) + "\n";

function hogar() {
  const raiz = mkdtempSync(join(tmpdir(), "vigilia-"));
  const raices = { tasks: join(raiz, "tasks"), projects: join(raiz, "projects"), salidas: join(raiz, "claude-1000") };
  mkdirSync(join(raices.tasks, A), { recursive: true });
  mkdirSync(join(raices.projects, "-home-x"), { recursive: true });
  mkdirSync(raices.salidas, { recursive: true });
  writeFileSync(join(raices.tasks, A, "1.json"), JSON.stringify({ subject: "Primera", status: "in_progress" }));
  writeFileSync(join(raices.projects, "-home-x", `${A}.jsonl`), linea(100));
  // A company session runs in another folder than its workspace's: found by its id alone.
  mkdirSync(join(raices.projects, "-home-compania"), { recursive: true });
  writeFileSync(join(raices.projects, "-home-compania", `${B}.jsonl`), linea(7) + JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "PARA DANI: ¿sigo?" }] } }) + "\n");
  return { raiz, raices, limpia: () => rmSync(raiz, { recursive: true, force: true }) };
}

const espera = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

test("the first call answers at once with every session's tasks, tokens, closing line and watchers", async () => {
  const h = hogar();
  const v = vigilia(h.raices, async () => ({ [A]: 2 }));
  try {
    const p = await v.espera([A, B], 0);
    assert.equal(p.changed, true);
    assert.deepEqual(p.tareas, { [A]: [{ subject: "Primera", status: "in_progress" }] });
    assert.deepEqual(p.contexto, { [A]: 100, [B]: 7 });
    assert.deepEqual(p.espera, { [B]: "dani" });
    assert.deepEqual(p.vigilantes, { [A]: 2 });
  } finally {
    v.cierra();
    h.limpia();
  }
});

test("while nothing changes nothing is read: a call at the current version is held, and many clients share one read", async () => {
  const h = hogar();
  let escaneos = 0;
  const v = vigilia(h.raices, async () => (escaneos++, {}));
  try {
    const { version } = await v.espera([A, B], 0);
    // Three clients at once, on a cache that is fresh: one scan in total, no file read again.
    await Promise.all([v.espera([A, B], 0), v.espera([A], 0), v.espera([B], 0)]);
    assert.equal(escaneos, 1);
    let resuelta = false;
    void v.espera([A, B], version).then(() => (resuelta = true));
    await espera(300);
    assert.equal(resuelta, false, "a call at the current version waits for a change");
    assert.equal(escaneos, 1);
  } finally {
    v.cierra();
    h.limpia();
  }
});

test("a write to a transcript wakes the held call with that session read again, and only that one", async () => {
  const h = hogar();
  const v = vigilia(h.raices, async () => ({}));
  try {
    const { version } = await v.espera([A, B], 0);
    const retenida = v.espera([A, B], version);
    await espera(100); // inotify is armed
    appendFileSync(join(h.raices.projects, "-home-x", `${A}.jsonl`), linea(250));
    const p = await retenida;
    assert.equal(p.changed, true);
    assert.ok(p.version > version);
    assert.equal(p.contexto[A], 250);
    assert.equal(p.contexto[B], 7);
  } finally {
    v.cierra();
    h.limpia();
  }
});

test("a task file written wakes the held call with the new list", async () => {
  const h = hogar();
  const v = vigilia(h.raices, async () => ({}));
  try {
    const { version } = await v.espera([A], 0);
    const retenida = v.espera([A], version);
    await espera(100);
    writeFileSync(join(h.raices.tasks, A, "2.json"), JSON.stringify({ subject: "Segunda", status: "pending" }));
    const p = await retenida;
    assert.equal(p.tareas[A]?.length, 2);
  } finally {
    v.cierra();
    h.limpia();
  }
});

test("a turn recounts the watchers once, and a background task file created does too", async () => {
  const h = hogar();
  let escaneos = 0;
  const v = vigilia(h.raices, async () => (escaneos++, {}));
  try {
    const { version } = await v.espera([A], 0);
    v.turno();
    const p = await v.espera([A], version);
    assert.equal(escaneos, 2);
    await espera(2_100); // the turn's notice has gone out: the next call is held at the current version
    const retenida = v.espera([A], p.version);
    await espera(100);
    mkdirSync(join(h.raices.salidas, "-home-x", A, "tasks"), { recursive: true });
    writeFileSync(join(h.raices.salidas, "-home-x", A, "tasks", "b1.output"), "");
    await retenida;
    assert.equal(escaneos, 3);
  } finally {
    v.cierra();
    h.limpia();
  }
});

test("a transcript created after the first look is found by the watch, without walking the projects again", async () => {
  const h = hogar();
  const v = vigilia(h.raices, async () => ({}));
  const nueva = "2f0e0d0c-0b0a-4908-8706-050403020100";
  try {
    const { version, contexto } = await v.espera([nueva], 0);
    assert.equal(contexto[nueva], undefined);
    const retenida = v.espera([nueva], version);
    await espera(100);
    mkdirSync(join(h.raices.projects, "-home-y"), { recursive: true });
    writeFileSync(join(h.raices.projects, "-home-y", `${nueva}.jsonl`), linea(42));
    // The session was never read with a transcript, so the write does not wake anyone: the next ask reads it from the index.
    v.turno();
    await retenida;
    assert.equal((await v.espera([nueva], 0)).contexto[nueva], 42);
  } finally {
    v.cierra();
    h.limpia();
  }
});
