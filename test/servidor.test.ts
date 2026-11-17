import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";

test("the server registers one held RPC, its settings and the turn-end hook, and returns the cleanup Paseo requires", async () => {
  const rpcs: string[] = [];
  const hooks = new Map<string, (evento: unknown, contexto: unknown) => Promise<void>>();
  const servidor = {
    handle: (contrato: { name: string }) => void rpcs.push(contrato.name),
    on: (nombre: string, gancho: (evento: unknown, contexto: unknown) => Promise<void>) => (hooks.set(nombre, gancho), () => {}),
    registerSettings: () => ({ read: async () => ({ status: "ready", values: { lado: "izquierda" } }) }),
  } as unknown as PluginServerContext;
  const limpia = contribute(servidor);
  assert.equal(typeof limpia, "function");
  assert.deepEqual(rpcs, ["panel.watch"]);
  assert.deepEqual([...hooks.keys()], ["agent.turn_ended"]);
  // The hook asks Paseo for the agent's session; an agent gone meanwhile is no error.
  const pedidos: string[] = [];
  const paseo = { agents: { ref: (id: string) => ({ refresh: async () => (pedidos.push(id), Promise.reject(new Error("gone"))) }) } };
  await hooks.get("agent.turn_ended")!({ agent: { id: "ag-1" } }, { paseo });
  assert.deepEqual(pedidos, ["ag-1"]);
  limpia();
});
