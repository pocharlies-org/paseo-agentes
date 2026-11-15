import assert from "node:assert/strict";
import { test } from "node:test";
import { aplica, vigilaPanel, type DatosPanel } from "../client/vigila.ts";
import type { Panel } from "../shared/contract.ts";

const vacio = (version: number, completo = false): Panel => ({ sesiones: {}, version, completo });

// A fake server: each call stays pending until the test answers it.
function servidor() {
  const llamadas: Array<{ input: { sesiones: string[]; since: number }; responde(p: Panel): void; falla(): void }> = [];
  const rpc = ((_contrato: unknown, input: { sesiones: string[]; since: number }) =>
    new Promise<Panel>((responde, falla) => llamadas.push({ input, responde, falla: () => falla(new Error("se fue")) }))) as never;
  return { rpc, llamadas };
}
const tic = () => new Promise((ok) => setImmediate(ok));

test("the client never asks on a clock: one call at a time, the next only when the last answers", async () => {
  const s = servidor();
  const vivo = new AbortController();
  const vistos: DatosPanel[] = [];
  const pide = vigilaPanel(s.rpc, (p) => vistos.push(p), vivo.signal);
  pide(["b", "a", "", "a"]);
  assert.deepEqual(s.llamadas.map((l) => l.input), [{ sesiones: ["a", "b"], since: 0 }]);
  // Agent updates with the same sessions (a turn starts, a title changes) leave the held call alone.
  pide(["a", "b"]);
  pide(["b", "a"]);
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(s.llamadas.length, 1, "no timer and no duplicate call");
  s.llamadas[0]!.responde(vacio(7, true));
  await tic();
  assert.equal(vistos.length, 1);
  assert.deepEqual(s.llamadas[1]!.input, { sesiones: ["a", "b"], since: 7 });
  // A held call that expires empty is not published and is followed by exactly one more.
  s.llamadas[1]!.responde(vacio(7));
  await tic();
  assert.equal(vistos.length, 1);
  assert.equal(s.llamadas.length, 3);
  vivo.abort();
});

test("a new agent restarts the call asking for everything; a failure waits for the next agent change, not a timer", async () => {
  const s = servidor();
  const vivo = new AbortController();
  const pide = vigilaPanel(s.rpc, () => {}, vivo.signal);
  pide(["a"]);
  s.llamadas[0]!.responde(vacio(3, true));
  await tic();
  assert.deepEqual(s.llamadas[1]!.input, { sesiones: ["a"], since: 3 });
  pide(["a", "c"]);
  assert.deepEqual(s.llamadas[2]!.input, { sesiones: ["a", "c"], since: 0 }, "a partial answer would not cover the new session");
  s.llamadas[1]!.responde(vacio(4)); // the superseded call's answer is ignored
  s.llamadas[2]!.falla();
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(s.llamadas.length, 3, "a failure schedules nothing");
  pide(["a", "c"]);
  assert.deepEqual(s.llamadas[3]!.input, { sesiones: ["a", "c"], since: 0 });
  vivo.abort();
  pide(["a", "c", "d"]);
  assert.equal(s.llamadas.length, 4, "nothing after the plugin is unloaded");
});

test("a complete answer replaces what the client had; a partial one changes only the sessions it brings", () => {
  const antes = aplica(
    { tareas: {}, contexto: {}, espera: {}, vigilantes: {} },
    {
      sesiones: { a: { tareas: [{ subject: "T", status: "pending" }], tokens: 10, espera: "ci" }, b: { tareas: [], tokens: 20, espera: null } },
      vigilantes: { a: 1 },
      version: 1,
      completo: true,
    },
  );
  assert.deepEqual(antes, { tareas: { a: [{ subject: "T", status: "pending" }] }, contexto: { a: 10, b: 20 }, espera: { a: "ci" }, vigilantes: { a: 1 } });
  const despues = aplica(antes, { sesiones: { a: { tareas: [], tokens: 15, espera: null } }, version: 2, completo: false });
  assert.deepEqual(despues, { tareas: {}, contexto: { a: 15, b: 20 }, espera: {}, vigilantes: { a: 1 } }, "a's list and wait are gone, b untouched");
  assert.deepEqual(antes.contexto, { a: 10, b: 20 }, "the previous state is not mutated: the view sees a new object");
  assert.deepEqual(aplica(despues, { sesiones: {}, version: 3, completo: true }).contexto, {}, "complete and empty: nothing left");
});
