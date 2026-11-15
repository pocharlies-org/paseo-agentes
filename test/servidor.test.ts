import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";

test("the server registers one held RPC, its settings and the turn hooks, and returns the cleanup Paseo requires", () => {
  const rpcs: string[] = [];
  const hooks: string[] = [];
  const servidor = {
    handle: (contrato: { name: string }) => void rpcs.push(contrato.name),
    on: (nombre: string) => (hooks.push(nombre), () => {}),
    registerSettings: () => ({ read: async () => ({ status: "ready", values: { lado: "izquierda" } }) }),
  } as unknown as PluginServerContext;
  const limpia = contribute(servidor);
  assert.equal(typeof limpia, "function");
  assert.deepEqual(rpcs, ["panel.watch"]);
  assert.deepEqual(hooks, ["agent.turn_started", "agent.turn_ended"]);
  limpia();
});
