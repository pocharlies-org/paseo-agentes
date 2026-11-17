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
  const raices = { tasks: join(raiz, "tasks"), projects: join(raiz, "projects") };
  mkdirSync(join(raices.tasks, A), { recursive: true });
  mkdirSync(join(raices.projects, "-home-x"), { recursive: true });
  writeFileSync(join(raices.tasks, A, "1.json"), JSON.stringify({ subject: "Primera", status: "in_progress" }));
  writeFileSync(join(raices.projects, "-home-x", `${A}.jsonl`), linea(100));
  // A company session runs in another folder than its workspace's: found by its id alone.
  mkdirSync(join(raices.projects, "-home-compania"), { recursive: true });
  writeFileSync(join(raices.projects, "-home-compania", `${B}.jsonl`), linea(7) + JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "PARA DANI: ¿sigo?" }] } }) + "\n");
  return { raiz, raices, limpia: () => rmSync(raiz, { recursive: true, force: true }) };
}

const espera = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const pendiente = <T>(promesa: Promise<T>) => {
  const estado = { resuelta: false };
  void promesa.then(() => (estado.resuelta = true));
  return estado;
};

test("the first call answers at once with every asked session and the watchers, marked complete", async () => {
  const h = hogar();
  const v = vigilia(h.raices, async () => ({ [A]: 2 }));
  try {
    const p = await v.espera([A, B], 0);
    assert.equal(p.completo, true);
    assert.deepEqual(p.sesiones, {
      [A]: { tareas: [{ subject: "Primera", status: "in_progress" }], tokens: 100, espera: null },
      [B]: { tareas: [], tokens: 7, espera: "dani" },
    });
    assert.deepEqual(p.vigilantes, { [A]: 2 });
    assert.ok(p.version >= Date.now() - 60_000, "the version starts at the instance's start, so an older since gets everything");
    assert.equal((await v.espera([A], 5)).completo, true, "a since from a previous instance");
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
    await Promise.all([v.espera([A, B], 0), v.espera([A], 0), v.espera([B], 0)]);
    assert.equal(escaneos, 1);
    const retenida = pendiente(v.espera([A, B], version));
    await espera(300);
    assert.equal(retenida.resuelta, false, "a call at the current version waits for a change");
    assert.equal(escaneos, 1);
  } finally {
    v.cierra();
    h.limpia();
  }
});

test("tokens alone wake no one: they ride along with the session's next move, and a tail without usage keeps the count", async () => {
  const h = hogar();
  const v = vigilia(h.raices, async () => ({}));
  try {
    const { version } = await v.espera([A, B], 0);
    const retenida = pendiente(v.espera([A, B], version));
    await espera(100); // inotify is armed
    appendFileSync(join(h.raices.projects, "-home-x", `${A}.jsonl`), linea(250));
    await espera(500);
    assert.equal(retenida.resuelta, false, "a running turn's tokens do not wake the held call");
    // A big tool result pushes the last usage out of the 64 KB tail read: still 250, not null.
    appendFileSync(join(h.raices.projects, "-home-x", `${A}.jsonl`), JSON.stringify({ message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(70_000) }] } }) + "\n");
    await espera(2_500); // the next round may run
    writeFileSync(join(h.raices.tasks, A, "2.json"), JSON.stringify({ subject: "Segunda", status: "pending" }));
    const p = await v.espera([A, B], version);
    assert.equal(p.completo, false);
    assert.ok(p.version > version);
    assert.deepEqual(Object.keys(p.sesiones), [A], "that session alone");
    assert.equal(p.sesiones[A]?.tokens, 250, "the tokens ride along with the task change");
    assert.equal(p.vigilantes, undefined, "the watchers did not change: not sent");
    assert.equal((await v.espera([A], 0)).sesiones[A]?.tokens, 250, "a complete answer brings the last count");
  } finally {
    v.cierra();
    h.limpia();
  }
});

test("a write that changes nothing shown does not wake anyone nor move the version", async () => {
  const h = hogar();
  const v = vigilia(h.raices, async () => ({}));
  try {
    const { version } = await v.espera([A, B], 0);
    const retenida = pendiente(v.espera([A, B], version));
    await espera(100);
    // A tool's progress line: no usage, no closing line, no user text.
    appendFileSync(join(h.raices.projects, "-home-x", `${A}.jsonl`), JSON.stringify({ type: "progress", data: "…" }) + "\n");
    await espera(500);
    assert.equal(retenida.resuelta, false);
    const ahora = await Promise.race([v.espera([A, B], version), espera(200).then(() => null)]);
    assert.equal(ahora, null, "still the same version: held");
  } finally {
    v.cierra();
    h.limpia();
  }
});

test("a client is not woken by another client's session", async () => {
  const h = hogar();
  const v = vigilia(h.raices, async () => ({}));
  try {
    const { version } = await v.espera([A, B], 0);
    const deA = pendiente(v.espera([A], version));
    const deB = v.espera([B], version);
    await espera(100);
    appendFileSync(join(h.raices.projects, "-home-compania", `${B}.jsonl`), JSON.stringify({ message: { role: "user", content: "sí" } }) + "\n");
    const p = await deB;
    assert.deepEqual(p.sesiones, { [B]: { tareas: [], tokens: 7, espera: null } }, "Dani answered: no longer waiting on him");
    await espera(200);
    assert.equal(deA.resuelta, false);
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
    assert.equal(p.sesiones[A]?.tareas.length, 2);
  } finally {
    v.cierra();
    h.limpia();
  }
});

test("a turn's end recounts that session alone, and only a different count wakes anyone", async () => {
  const h = hogar();
  // B is mid-turn in the later scans: its foreground commands hold task files too, and must not show nor wake anyone.
  const cuentas: Record<string, number>[] = [{ [A]: 1, [B]: 1 }, { [A]: 1, [B]: 3 }, { [B]: 4 }];
  let escaneos = 0;
  const v = vigilia(h.raices, async () => cuentas[Math.min(escaneos++, cuentas.length - 1)]!);
  try {
    const { version } = await v.espera([A, B], 0);
    const retenida = v.espera([A, B], version);
    const sigue = pendiente(retenida);
    v.turno(A); // A's count is the same, B's change is not A's turn: nobody woken
    await espera(300);
    assert.equal(escaneos, 2);
    assert.equal(sigue.resuelta, false);
    v.turno(A); // A's background task ended: the next round (AVISO_MS later) counts it
    const p = await retenida;
    assert.equal(escaneos, 3);
    assert.deepEqual(p.vigilantes, { [B]: 1 }, "A has none left, B keeps the count of its own last turn end");
    assert.deepEqual(p.sesiones, {});
  } finally {
    v.cierra();
    h.limpia();
  }
});

test("a transcript created after the first look is found by the watch and wakes its session's caller", async () => {
  const h = hogar();
  const v = vigilia(h.raices, async () => ({}));
  const nueva = "2f0e0d0c-0b0a-4908-8706-050403020100";
  try {
    const primera = await v.espera([nueva], 0);
    assert.deepEqual(primera.sesiones[nueva], { tareas: [], tokens: null, espera: null });
    const retenida = v.espera([nueva], primera.version);
    await espera(100);
    mkdirSync(join(h.raices.projects, "-home-y"), { recursive: true });
    writeFileSync(join(h.raices.projects, "-home-y", `${nueva}.jsonl`), linea(42) + JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "PARA DANI: ¿sigo?" }] } }) + "\n");
    assert.deepEqual((await retenida).sesiones[nueva], { tareas: [], tokens: 42, espera: "dani" });
  } finally {
    v.cierra();
    h.limpia();
  }
});
