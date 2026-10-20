import { execFile } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";

// Claude Code writes each task's output to <tmp>/claude-<uid>/<cwd key>/<session id>/tasks/<task id>.output; the shell running
// it holds the file open until it ends. Paseo keeps no state for background shells, so this is the only place they show.
const TAREA = /\/claude-\d+\/[^/]+\/([0-9a-f-]{36})\/tasks\/([^/]+)\.output$/;

type Opciones = { proc?: string; lsof?: string; uid?: number | undefined; sinCache?: boolean };

/** Counts distinct session/task pairs out of open-file paths, so one task held by several processes counts once. */
function cuenta(rutas: Iterable<string>): Record<string, number> {
  const sesionDeTarea = new Map<string, string>();
  for (const ruta of rutas) {
    const tarea = TAREA.exec(ruta);
    if (tarea) sesionDeTarea.set(`${tarea[1]}/${tarea[2]}`, tarea[1]!);
  }
  const total: Record<string, number> = {};
  for (const sesion of sesionDeTarea.values()) total[sesion] = (total[sesion] ?? 0) + 1;
  return total;
}

/** Linux: the open files of every process the daemon's user may read. Async so the daemon loop never waits on it; rejects if proc is unreadable. */
async function rutasDeProc(proc: string): Promise<string[]> {
  const rutas: string[] = [];
  for (const pid of await readdir(proc)) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try {
      fds = await readdir(`${proc}/${pid}/fd`);
    } catch {
      continue; // gone meanwhile, or another user's
    }
    for (const fd of fds) {
      try {
        rutas.push(await readlink(`${proc}/${pid}/fd/${fd}`));
      } catch {
        continue;
      }
    }
  }
  return rutas;
}

/** `lsof -F n` output: one `n<path>` line per open file (`p<pid>` lines are ignored). */
export function rutasDeLsof(salida: string): string[] {
  const rutas: string[] = [];
  for (const linea of salida.split("\n")) if (linea.startsWith("n")) rutas.push(linea.slice(1));
  return rutas;
}

/** macOS and other Unix without /proc: async so the daemon loop never waits on it; any failure or timeout is an empty list. */
function rutasDeLsofProceso(lsof: string, uid: number): Promise<string[]> {
  return new Promise((ok) => {
    try {
      // -n/-P skip DNS and port-name lookups; -F n prints names only. lsof exits 1 when it lists nothing, which is not an error here.
      execFile(lsof, ["-n", "-P", "-u", String(uid), "-F", "n"], { timeout: 5000, maxBuffer: 64 * 1024 * 1024 }, (error, salida) => {
        ok(error && !salida ? [] : rutasDeLsof(String(salida)));
      });
    } catch {
      ok([]);
    }
  });
}

/** The real read: /proc where it exists, lsof otherwise. Never throws — where neither works (Windows, lsof missing, timeout) it returns {}. */
async function escanea(proc: string, lsof: string, uid: number | undefined): Promise<Record<string, number>> {
  try {
    return cuenta(await rutasDeProc(proc));
  } catch {
    // no /proc here: fall through to lsof
  }
  if (uid === undefined || process.platform === "win32") return {};
  try {
    return cuenta(await rutasDeLsofProceso(lsof, uid));
  } catch {
    return {};
  }
}

// The client re-reads on every agent change (throttled at 3 s); on a busy host a full scan can outlast the RPC timeout and pile
// up. A fresh result is reused for CADUCIDAD and a scan already running for the same target is shared, so two reads in a row
// cost one scan and concurrent reads never stack.
const CADUCIDAD = 2000;
let guarda: { clave: string; valor: Record<string, number>; hasta: number } | null = null;
const enCurso = new Map<string, Promise<Record<string, number>>>();

/**
 * Running Claude Code tasks per session id: the task files some live process holds open. Reads only what the daemon's user
 * may read. Never throws. shortcut: a command the agent runs in the foreground during its turn counts too (same task file);
 * fine while the row already says the turn runs, upgrade if Claude Code marks backgrounded tasks apart.
 */
export async function vigilantes(opciones: Opciones = {}): Promise<Record<string, number>> {
  // absolute by default: macOS ships it in /usr/sbin, which a daemon started from a GUI or launchd may not have on PATH
  const { proc = "/proc", lsof = "/usr/sbin/lsof" } = opciones;
  const uid = "uid" in opciones ? opciones.uid : process.getuid?.();
  if (opciones.sinCache) return escanea(proc, lsof, uid);
  const clave = `${proc} ${lsof} ${uid}`;
  const ahora = Date.now();
  if (guarda && guarda.clave === clave && guarda.hasta > ahora) return guarda.valor;
  const previo = enCurso.get(clave);
  if (previo) return previo;
  const lectura = escanea(proc, lsof, uid).then((valor) => {
    enCurso.delete(clave);
    guarda = { clave, valor, hasta: Date.now() + CADUCIDAD };
    return valor;
  });
  enCurso.set(clave, lectura);
  return lectura;
}
