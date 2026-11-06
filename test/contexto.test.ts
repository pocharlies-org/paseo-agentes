import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cierreDe, contexto, esperaDe, tareas, tokensDeContexto } from "../server/contexto.ts";

const sesion = "0f0e0d0c-0b0a-4908-8706-050403020100";

test("the closing line waits until a real answer arrives; a tool result is not an answer", () => {
  const asis = (text: string) => JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text }] } });
  const usuario = (content: unknown) => JSON.stringify({ message: { role: "user", content } });
  assert.equal(esperaDe([usuario("haz X"), asis("Listo.\nPARA DANI: ¿apruebo?")].join("\n")), "dani");
  assert.equal(esperaDe([usuario("haz X"), asis("PARA DANI: ¿apruebo?"), usuario("sí")].join("\n")), null);
  assert.equal(esperaDe([asis("PARA DANI: ¿apruebo?"), usuario([{ type: "tool_result", content: "ok" }])].join("\n")), "dani");
  assert.equal(esperaDe([usuario("haz X"), asis("Listo.")].join("\n")), null);
  assert.equal(esperaDe("línea rota\n{no es json"), null);
  // The last turn decides: an older closing line under a newer one does not count.
  assert.equal(esperaDe([asis("ESPERA: ci org/r#1 → fusiono"), usuario([{ type: "tool_result", content: "" }]), asis("Hecho.\n\nESTADO: ENTREGA")].join("\n")), "entrega");
});

test("a closing line reads as what it depends on: Dani, another session, CI, a date, or done", () => {
  assert.equal(cierreDe("Queda el merge.\n\nESPERA: ci pocharlies-org/paseo-agentes#31 → fusiono"), "ci");
  assert.equal(cierreDe("ESPERA: merge org/repo#2"), "ci");
  assert.equal(cierreDe("- ESPERA: run org/repo 4224 → miro"), "ci");
  assert.equal(cierreDe("**ESPERA:** argocd skirmshop-control-panel → valido"), "ci");
  assert.equal(cierreDe("ESPERA: jira SC-4777 → sigo cuando cierre"), "sesion");
  assert.equal(cierreDe("PARA IT: falta la credencial\nPaseo: abc"), "sesion");
  assert.equal(cierreDe("ESPERA: fecha 2026-11-07 09:00 → reviso"), "fecha");
  assert.equal(cierreDe("Todo listo.\n\nESTADO: ENTREGA"), "entrega");
  // Dani beats the rest; another session beats CI.
  assert.equal(cierreDe("ESPERA: ci org/r#1\nPARA DANI: ¿pago 30 €?"), "dani");
  assert.equal(cierreDe("ESPERA: ci org/r#1\nESPERA: jira SC-1"), "sesion");
  // Prose that only mentions the words is not a closing line.
  assert.equal(cierreDe("El supervisor lee la ESPERA del turno y el estado de entrega."), null);
  assert.equal(cierreDe("Nada más."), null);
});

test("the task list is read ordered and with its statuses; a session without directory has none", async () => {
  const raiz = mkdtempSync(join(mkdtempSync("/tmp/"), "tasks-"));
  try {
    mkdirSync(join(raiz, sesion), { recursive: true });
    writeFileSync(join(raiz, sesion, "2.json"), JSON.stringify({ subject: "Segunda", status: "in_progress" }));
    writeFileSync(join(raiz, sesion, "1.json"), JSON.stringify({ subject: "Primera", status: "completed" }));
    writeFileSync(join(raiz, sesion, "3.json"), "{ roto");
    writeFileSync(join(raiz, sesion, "4.json"), JSON.stringify({ subject: "Sin estado válido", status: "raro" }));
    const leidas = await tareas(sesion, raiz);
    assert.deepEqual(leidas, [
      { subject: "Primera", status: "completed" },
      { subject: "Segunda", status: "in_progress" },
    ]);
    assert.deepEqual(await tareas("no-existe", raiz), []);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test("the last usage of the transcript is the context used; a torn last line keeps looking upward", () => {
  const suelta = [
    JSON.stringify({ message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } } }),
    JSON.stringify({ message: { usage: { input_tokens: 7, cache_read_input_tokens: 1000 } } }),
    '{"message": {"usage": {"input_tokens": 9',
  ].join("\n");
  assert.equal(tokensDeContexto(suelta), 1007);
  assert.equal(tokensDeContexto(JSON.stringify({ type: "user" })), null);
});

test("the transcript is found by the escaped cwd; a missing one is null, never a throw", async () => {
  const raiz = mkdtempSync(join(mkdtempSync("/tmp/"), "projects-"));
  const cwd = "/home/x/proyecto";
  try {
    mkdirSync(join(raiz, cwd.replace(/\//g, "-")), { recursive: true });
    writeFileSync(
      join(raiz, cwd.replace(/\//g, "-"), `${sesion}.jsonl`),
      JSON.stringify({ message: { usage: { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } }) + "\n",
    );
    assert.equal(await contexto(sesion, cwd, raiz), 6);
    assert.equal(await contexto(sesion, "/home/x/otro", raiz), null);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});
