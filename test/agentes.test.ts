import assert from "node:assert/strict";
import { test } from "node:test";
import { agrupar, grupoDe, insignias, leePlegado, type Agente } from "../shared/agentes.ts";

const agente = (id: string, extra: Partial<Agente> = {}): Agente => ({
  id,
  title: id,
  status: "idle",
  createdAt: "2026-10-13T10:00:00.000Z",
  pendingPermissions: [],
  ...extra,
});

test("Paseo's precedence: data beats error, error beats a running turn, a turn beats an unseen end", () => {
  assert.equal(grupoDe(agente("a", { status: "running", pendingPermissions: [{}] })), "necesitaDatos");
  assert.equal(grupoDe(agente("b", { attentionReason: "permission", requiresAttention: true })), "necesitaDatos");
  assert.equal(grupoDe(agente("c", { status: "running", attentionReason: "error" })), "conError");
  assert.equal(grupoDe(agente("d", { status: "running", requiresAttention: true, attentionReason: "finished" })), "enEjecucion");
  assert.equal(grupoDe(agente("e", { requiresAttention: true, attentionReason: "finished" })), "paraRevisar");
  assert.equal(grupoDe(agente("f", { status: "error", requiresAttention: true, attentionReason: "error" })), "conError");
});

test("every agent lands in a group: one already seen is Terminado", () => {
  assert.equal(grupoDe(agente("a")), "terminado");
  assert.equal(grupoDe(agente("b", { status: "error" })), "conError");
  assert.equal(grupoDe(agente("c", { status: "initializing" })), "terminado");
});

test("groups come in order, empty ones are left out, and the newest is first", () => {
  const grupos = agrupar([
    agente("visto"),
    agente("viejo", { status: "running", createdAt: "2026-10-13T09:00:00.000Z" }),
    agente("acabado", { requiresAttention: true, attentionTimestamp: "2026-10-13T11:00:00.000Z" }),
    agente("nuevo", { status: "running", createdAt: "2026-10-13T12:00:00.000Z" }),
    agente("roto", { status: "error" }),
    agente("pregunta", { pendingPermissions: [{}], attentionTimestamp: "2026-10-13T08:00:00.000Z" }),
  ]);
  assert.deepEqual(
    grupos.map(({ titulo, agentes }) => [titulo, agentes.map(({ id }) => id)]),
    [
      ["Necesita datos", ["pregunta"]],
      ["Con error", ["roto"]],
      ["Para revisar", ["acabado"]],
      ["En ejecución", ["nuevo", "viejo"]],
      ["Terminado", ["visto"]],
    ],
  );
});

test("a stored fold is read back, and a broken or foreign one reads as nothing folded", () => {
  assert.deepEqual(leePlegado(JSON.stringify({ bloque: true, grupos: ["paraRevisar", "otro", "toString"], ocultos: ["prj_1", 7] })), {
    bloque: true,
    grupos: ["paraRevisar"],
    ocultos: ["prj_1"],
  });
  // Nothing stored, or a save from before "Terminado" existed (no `ocultos`): it starts folded.
  const plegadoVacio = { bloque: false, grupos: ["terminado"], ocultos: [] };
  for (const texto of [null, "", "{", "7", '"x"', '{"bloque":"si","grupos":"marcha"}', '{"bloque":false,"grupos":[]}']) {
    assert.deepEqual(leePlegado(texto), plegadoVacio);
  }
  // A save that knows "Terminado" respects the explicit choice, even if it is unfolded.
  assert.deepEqual(leePlegado('{"bloque":false,"grupos":[],"ocultos":[]}'), { bloque: false, grupos: [], ocultos: [] });
});

test("a project gets the letter and color of Paseo's workspace list", () => {
  const servidor = "srv_xffL1eDZ_JRc";
  const iconos = insignias(servidor, [
    // Colors seen in Paseo's sidebar on 2026-10-13: Hermes teal, k8s red.
    { projectId: "hermes", projectKey: `host:${servidor}:/home/dibanez/.local/state/x86-host-runtime/paseo-categorias/hermes`, projectDisplayName: "hermes", projectCustomName: "Hermes" },
    { projectId: "k8s", projectKey: `host:${servidor}:/home/dibanez/k8s`, projectDisplayName: "k8s" },
    { projectId: "repo", projectDisplayName: "pocharlies-org/repo" },
    { projectId: "a", projectKey: "remote:github.com/org/clon", projectDisplayName: "clon" },
    { projectId: "b", projectKey: "remote:github.com/org/clon", projectDisplayName: "clon" },
  ]);
  assert.deepEqual(iconos.get("hermes"), { inicial: "H", color: "#368080" });
  assert.deepEqual(iconos.get("k8s"), { inicial: "K", color: "#b06260" });
  assert.equal(iconos.get("repo")?.inicial, "R");
  // Two projects sharing a key are told apart by host and projectId, as Paseo does.
  assert.notEqual(iconos.get("a")?.color, undefined);
  assert.deepEqual(insignias(servidor, [{ projectId: "a", projectDisplayName: "clon" }]).get("a"), iconos.get("a"));
});
