import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";

test("the server registers one held RPC, its settings and the turn-end hook, and returns the cleanup Paseo requires", async () => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "servidor-")); // the watches open under the home's .claude
  const rpcs: string[] = [];
  let panel: ((entrada: { sesiones: string[]; since: number }) => Promise<unknown>) | null = null;
  const hooks = new Map<string, (evento: unknown, contexto: unknown) => Promise<void>>();
  const servidor = {
    handle: (contrato: { name: string }, manejador: typeof panel) => void (rpcs.push(contrato.name), (panel = manejador)),
    on: (nombre: string, gancho: (evento: unknown, contexto: unknown) => Promise<void>) => (hooks.set(nombre, gancho), () => {}),
    registerSettings: () => ({ read: async () => ({ status: "ready", values: { lado: "izquierda" } }) }),
  } as unknown as PluginServerContext;
  const limpia = contribute(servidor);
  assert.equal(typeof limpia, "function");
  assert.deepEqual(rpcs, ["panel.watch"]);
  assert.deepEqual([...hooks.keys()], ["agent.turn_ended"]);
  // Nobody shows the panel yet: a turn's end asks Paseo nothing.
  const pedidos: string[] = [];
  const paseo = { agents: { ref: (id: string) => ({ refresh: async () => (pedidos.push(id), Promise.reject(new Error("gone"))) }) } };
  await hooks.get("agent.turn_ended")!({ agent: { id: "ag-0" } }, { paseo });
  assert.deepEqual(pedidos, []);
  // Once a client holds the panel, the hook asks Paseo for the agent's session; an agent gone meanwhile is no error.
  await panel!({ sesiones: [], since: 0 });
  await hooks.get("agent.turn_ended")!({ agent: { id: "ag-1" } }, { paseo });
  assert.deepEqual(pedidos, ["ag-1"]);
  limpia();
});
