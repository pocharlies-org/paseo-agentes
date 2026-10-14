import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server.ts";

test("the server part registers vigilantes.list and returns the cleanup Paseo requires", () => {
  const rpcs: string[] = [];
  const servidor = { handle: (contrato: { name: string }) => void rpcs.push(contrato.name) } as unknown as PluginServerContext;
  assert.equal(typeof contribute(servidor), "function");
  assert.deepEqual(rpcs, ["vigilantes.list"]);
});
