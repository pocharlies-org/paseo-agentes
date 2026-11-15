import assert from "node:assert/strict";
import { test } from "node:test";
import { vigilaPanel } from "../client/vigila.ts";
import type { Panel } from "../shared/contract.ts";

const vacio = (version: number, changed: boolean): Panel => ({ tareas: {}, contexto: {}, espera: {}, vigilantes: {}, version, changed });

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
  const vistos: Panel[] = [];
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
  // A held call that expires without change is not published and is followed by exactly one more.
  s.llamadas[1]!.responde(vacio(7, false));
  await tic();
  assert.equal(vistos.length, 1);
  assert.equal(s.llamadas.length, 3);
  vivo.abort();
});

test("a new agent restarts the call with its session; a failure waits for the next agent change, not a timer", async () => {
  const s = servidor();
  const vivo = new AbortController();
  const pide = vigilaPanel(s.rpc, () => {}, vivo.signal);
  pide(["a"]);
  pide(["a", "c"]);
  assert.equal(s.llamadas.length, 2);
  assert.deepEqual(s.llamadas[1]!.input.sesiones, ["a", "c"]);
  s.llamadas[0]!.responde(vacio(3, true)); // the superseded call's answer is ignored
  s.llamadas[1]!.falla();
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(s.llamadas.length, 2, "a failure schedules nothing");
  pide(["a", "c"]);
  assert.deepEqual(s.llamadas[2]!.input, { sesiones: ["a", "c"], since: 0 });
  vivo.abort();
  pide(["a", "c", "d"]);
  assert.equal(s.llamadas.length, 3, "nothing after the plugin is unloaded");
});
