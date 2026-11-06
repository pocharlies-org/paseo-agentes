import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Espera, Tarea } from "../shared/contract.ts";

// Claude Code keeps each session's task list in ~/.claude/tasks/<session id>/<n>.json and its transcript in
// ~/.claude/projects/<cwd escaped>/<session id>.jsonl. Both live on the daemon host, so the panel reads them here.

/** The task list of one session, ordered by task number; {} parts when the directory does not exist (session with no tasks). */
export async function tareas(sesion: string, raiz = join(homedir(), ".claude", "tasks")): Promise<Tarea[]> {
  let nombres: string[];
  try {
    nombres = await readdir(join(raiz, sesion));
  } catch {
    return [];
  }
  const tareas: Tarea[] = [];
  for (const nombre of nombres) {
    if (!nombre.endsWith(".json")) continue;
    try {
      const leido = JSON.parse(await readFile(join(raiz, sesion, nombre), "utf8"));
      if (typeof leido?.subject === "string" && (leido.status === "pending" || leido.status === "in_progress" || leido.status === "completed"))
        tareas.push({ subject: leido.subject, status: leido.status });
    } catch {
      // A half-written file is skipped; the next read sees it whole.
    }
  }
  return tareas;
}

/** The last `usage` of a transcript: input + cache tokens = what the context holds. Null when there is no transcript or usage. */
export function tokensDeContexto(suelta: string): number | null {
  const lineas = suelta.split("\n");
  for (let i = lineas.length - 1; i >= 0; i--) {
    const linea = lineas[i]!;
    if (!linea.includes('"usage"')) continue;
    try {
      const entrada = JSON.parse(linea);
      const u = entrada?.message?.usage ?? entrada?.usage;
      if (!u || typeof u.input_tokens !== "number") continue;
      return u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    } catch {
      // A torn last line: keep looking upward.
    }
  }
  return null;
}

/**
 * Where the session's JSONL is: under its workspace directory, or — when the session runs elsewhere (a company session
 * lives in a Paseo category folder but runs in ~/compania) — under whichever project holds that session id, which is unique.
 */
async function rutaDe(sesion: string, cwd: string, proyectos: string): Promise<string | null> {
  const directa = join(proyectos, cwd.replace(/\//g, "-"), `${sesion}.jsonl`);
  try {
    await stat(directa);
    return directa;
  } catch {
    // shortcut: one readdir of ~/.claude/projects per miss; cache it if the host grows past a few hundred projects.
    for (const carpeta of await readdir(proyectos).catch(() => [] as string[])) {
      const ruta = join(proyectos, carpeta, `${sesion}.jsonl`);
      if (await stat(ruta).then(() => true, () => false)) return ruta;
    }
    return null;
  }
}

/** Reads the tail of the session's JSONL (the last turn is all that is needed); null if there is none. */
export async function lectura(sesion: string, cwd: string, proyectos = join(homedir(), ".claude", "projects")): Promise<string | null> {
  const ruta = await rutaDe(sesion, cwd, proyectos);
  if (!ruta) return null;
  try {
    const fh = await open(ruta, "r");
    try {
      const { size } = await fh.stat();
      const desde = Math.max(0, size - 64 * 1024);
      const buffer = Buffer.alloc(size - desde);
      await fh.read(buffer, 0, buffer.length, desde);
      return buffer.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export async function contexto(sesion: string, cwd: string, proyectos = join(homedir(), ".claude", "projects")): Promise<number | null> {
  const suelta = await lectura(sesion, cwd, proyectos);
  return suelta === null ? null : tokensDeContexto(suelta);
}

// La gramática del cierre de turno de la casa, la misma que lee el supervisor (company_runtime ESPERA_RE / PARA_RE /
// company-sesion ESTADO_RE): solo hace falta saber DE QUÉ depende la sesión, no el objetivo exacto.
const CIERRE_ESPERA = /^[ \t]*(?:[-*>•]+[ \t]*)?[`*_]*ESPERA[`*_]*[ \t]*:[`*_]*[ \t]*(ci|merge|review|run|argocd|jira|fecha|fichero)\b/gim;
const CIERRE_DANI = /^[ \t>*_`-]*PARA DANI[^\n:]{0,20}[:：]/im;
const CIERRE_PARA = /^[ \t>*_`-]*PARA (IT|SECURITY|QA)[^\n:]{0,20}:/im;
const CIERRE_ENTREGA = /^[ \t>*_`-]*ESTADO[ \t*_`]*:[ \t*_`]*ENTREGA\b/im;
const DE_CI = new Set(["ci", "merge", "review", "run", "argocd"]);

/**
 * De qué depende el último cierre de un turno: Dani manda (PARA DANI), luego lo de otro (ESPERA: jira, o PARA IT/SECURITY/QA),
 * luego CI (ci, merge, review, run, argocd), luego el reloj (fecha); ESTADO: ENTREGA es «hecho». Null sin cierre reconocible.
 */
export function cierreDe(texto: string): Espera | null {
  if (CIERRE_DANI.test(texto)) return "dani";
  const tipos = new Set([...texto.matchAll(CIERRE_ESPERA)].map((m) => m[1]!.toLowerCase()));
  if (tipos.has("jira") || CIERRE_PARA.test(texto)) return "sesion";
  if ([...tipos].some((t) => DE_CI.has(t))) return "ci";
  if (tipos.has("fecha") || tipos.has("fichero")) return "fecha";
  return CIERRE_ENTREGA.test(texto) ? "entrega" : null;
}

/**
 * A qué espera la sesión según el cierre de su último turno. Se busca hacia atrás desde el final del transcript: la primera
 * respuesta real del usuario (texto escrito, no un resultado de herramienta) lo anula; el primer texto del agente con un
 * cierre lo decide. El cierre es la ley de la casa para cada turno (reglas de la compañía; hook Stop de Paseo, SC-4137).
 */
export function esperaDe(suelta: string): Espera | null {
  const lineas = suelta.split("\n");
  for (let i = lineas.length - 1; i >= 0; i--) {
    const linea = lineas[i]!;
    if (!linea.includes('"role"')) continue;
    let mensaje: { role?: string; content?: unknown };
    try {
      mensaje = JSON.parse(linea)?.message;
    } catch {
      continue; // A torn last line: keep looking upward.
    }
    if (!mensaje || typeof mensaje.role !== "string") continue;
    const partes = Array.isArray(mensaje.content) ? (mensaje.content as { type?: string; text?: string }[]) : [];
    if (mensaje.role === "user") {
      if (typeof mensaje.content === "string" && mensaje.content.trim() !== "") return null;
      if (partes.some((parte) => parte.type === "text")) return null;
      continue; // A tool result is not an answer.
    }
    if (mensaje.role !== "assistant") continue;
    const texto = typeof mensaje.content === "string" ? mensaje.content : partes.map((parte) => parte.text ?? "").join("\n");
    const cierre = cierreDe(texto);
    if (cierre) return cierre;
  }
  return null;
}
