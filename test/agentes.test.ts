import assert from "node:assert/strict";
import { test } from "node:test";
import { agrupar, grupoDe, type Agente } from "../shared/agentes.ts";

const agente = (id: string, extra: Partial<Agente> = {}): Agente => ({
  id,
  title: id,
  status: "idle",
  createdAt: "2026-10-13T10:00:00.000Z",
  pendingPermissions: [],
  ...extra,
});

test("a pending question beats a running turn, which beats an unseen end", () => {
  assert.equal(grupoDe(agente("a", { status: "running", pendingPermissions: [{}] })), "pregunta");
  assert.equal(grupoDe(agente("b", { attentionReason: "permission", requiresAttention: true })), "pregunta");
  assert.equal(grupoDe(agente("c", { status: "running", requiresAttention: true, attentionReason: "finished" })), "marcha");
  assert.equal(grupoDe(agente("d", { requiresAttention: true, attentionReason: "finished" })), "sinVer");
  assert.equal(grupoDe(agente("e", { status: "error", requiresAttention: true, attentionReason: "error" })), "sinVer");
});

test("an idle agent already seen, or one that failed and was seen, is in no group", () => {
  assert.equal(grupoDe(agente("a")), null);
  assert.equal(grupoDe(agente("b", { status: "error" })), null);
  assert.equal(grupoDe(agente("c", { status: "initializing" })), null);
});

test("groups come in order, empty ones are left out, and the newest is first", () => {
  const grupos = agrupar([
    agente("visto"),
    agente("viejo", { status: "running", createdAt: "2026-10-13T09:00:00.000Z" }),
    agente("acabado", { requiresAttention: true, attentionTimestamp: "2026-10-13T11:00:00.000Z" }),
    agente("nuevo", { status: "running", createdAt: "2026-10-13T12:00:00.000Z" }),
  ]);
  assert.deepEqual(
    grupos.map(({ titulo, agentes }) => [titulo, agentes.map(({ id }) => id)]),
    [
      ["En marcha", ["nuevo", "viejo"]],
      ["Sin ver", ["acabado"]],
    ],
  );
});
