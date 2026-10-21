import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";

test("the server part registers its RPCs and settings and returns the cleanup Paseo requires", () => {
  const rpcs: string[] = [];
  const servidor = {
    handle: (contrato: { name: string }) => void rpcs.push(contrato.name),
    registerSettings: () => ({ read: async () => ({ status: "ready", values: { lado: "izquierda" } }) }),
  } as unknown as PluginServerContext;
  assert.equal(typeof contribute(servidor), "function");
  assert.deepEqual(rpcs, ["vigilantes.list", "cambios.list", "contexto.list"]);
});
