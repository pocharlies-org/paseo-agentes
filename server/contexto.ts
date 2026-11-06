import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tarea } from "../shared/contract.ts";

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

/** Reads the tail of the session's JSONL (the last turn is all that is needed); null if the file is not where the cwd says. */
export async function lectura(sesion: string, cwd: string, proyectos = join(homedir(), ".claude", "projects")): Promise<string | null> {
  const ruta = join(proyectos, cwd.replace(/\//g, "-"), `${sesion}.jsonl`);
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

/**
 * ¿El último turno del agente dejó un «PARA DANI:» sin respuesta? Se busca hacia atrás desde el final del transcript:
 * la primera respuesta real del usuario (texto escrito, no un resultado de herramienta) cierra la espera; un texto del
 * agente con la marca la abre. La marca es la ley de la casa para «espera a Dani» (reglas de la compañía).
 */
export function esperaDeDani(suelta: string): boolean {
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
      if (typeof mensaje.content === "string" && mensaje.content.trim() !== "") return false;
      if (partes.some((parte) => parte.type === "text")) return false;
      continue; // A tool result is not an answer.
    }
    if (mensaje.role !== "assistant") continue;
    const texto = typeof mensaje.content === "string" ? mensaje.content : partes.map((parte) => parte.text ?? "").join("\n");
    if (/(^|\n)\s*PARA DANI[:：]/.test(texto)) return true;
  }
  return false;
}
