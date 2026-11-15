import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Espera, Panel, Tarea } from "../shared/contract.ts";
import { esperaDe, leeCola, tareas as leeTareas, tokensDeContexto } from "./contexto.ts";
import { vigilantes } from "./vigilantes.ts";

/**
 * The panel's data that Paseo has no event for — Claude Code's task lists and transcripts, and the watchers holding task files
 * open — kept in one cache that only a change invalidates (SC-5601). The PR of each workspace is not here: Paseo's own forge
 * observer sends it with every workspace update (`githubRuntime`). Three recursive inotify watches (one instance each) say what
 * changed; nothing is read again while nothing changes, and every client shares one read. Clients wait on `espera(since)`.
 */

const RETENCION_MS = 20_000; // a held call answers by then: under the daemon's 30 s plugin request timeout
const AVISO_MS = 2_000; // a running turn writes its transcript many times a second: clients hear of it at most this often
const LECTURAS = 4; // reads of files or processes at once

export interface Raices {
  readonly tasks: string;
  readonly projects: string;
  /** Where Claude Code writes each background task's output: `<tmp>/claude-<uid>` (see vigilantes.ts). */
  readonly salidas: string;
}

const raicesPorDefecto = (): Raices => ({
  tasks: join(homedir(), ".claude", "tasks"),
  projects: join(homedir(), ".claude", "projects"),
  salidas: join(tmpdir(), `claude-${process.getuid?.() ?? 0}`),
});

interface PorSesion {
  tareas: Tarea[];
  tokens: number | null;
  espera: Espera | null;
}

export interface Vigilia {
  /** The panel for these sessions: at once when the version is past `since`, else when it moves or the hold expires. */
  espera(sesiones: readonly string[], since: number): Promise<Panel>;
  /** A turn started or ended: the background tasks it launched or that woke it are counted again. */
  turno(): void;
  cierra(): void;
}

export function vigilia(raices: Raices = raicesPorDefecto(), contarVigilantes: () => Promise<Record<string, number>> = () => vigilantes()): Vigilia {
  let version = 1;
  let avisado = 0;
  const esperando = new Set<() => void>();
  let aviso: ReturnType<typeof setTimeout> | null = null;
  const avisa = () => {
    aviso = null;
    avisado = Date.now();
    for (const despierta of [...esperando]) despierta();
  };
  const sube = () => {
    version++;
    aviso ??= setTimeout(avisa, Math.max(0, avisado + AVISO_MS - Date.now()));
  };

  let activas = 0;
  const cola: Array<() => void> = [];
  const turnoDeLectura = async <T>(leer: () => Promise<T>): Promise<T> => {
    if (activas < LECTURAS) activas++;
    else await new Promise<void>((sigue) => cola.push(sigue)); // the read that ends hands its slot over
    try {
      return await leer();
    } finally {
      const siguiente = cola.shift();
      if (siguiente) siguiente();
      else activas--;
    }
  };

  // Where each session's transcript is, by session id: `<projects>/<folder>/<id>.jsonl`. Walked once, then kept by the watch
  // (a company session runs in another folder than its workspace's, so the id is the only reliable key).
  let indice: Promise<Map<string, string>> | null = null;
  const transcripts = () =>
    (indice ??= (async () => {
      const mapa = new Map<string, string>();
      for (const carpeta of await readdir(raices.projects).catch(() => [] as string[])) {
        for (const nombre of await readdir(join(raices.projects, carpeta)).catch(() => [] as string[])) {
          if (nombre.endsWith(".jsonl")) mapa.set(nombre.slice(0, -".jsonl".length), join(raices.projects, carpeta, nombre));
        }
      }
      return mapa;
    })());

  const sesiones = new Map<string, Promise<PorSesion>>();
  const leeSesion = (id: string) => {
    const hecho = sesiones.get(id);
    if (hecho) return hecho;
    const lectura: Promise<PorSesion> = turnoDeLectura(async () => {
      const ruta = (await transcripts()).get(id);
      const suelta = ruta ? await leeCola(ruta) : null;
      return { tareas: await leeTareas(id, raices.tasks), tokens: suelta === null ? null : tokensDeContexto(suelta), espera: suelta === null ? null : esperaDe(suelta) };
    }).catch(() => {
      if (sesiones.get(id) === lectura) sesiones.delete(id); // a failed read is not kept
      return { tareas: [], tokens: null, espera: null };
    });
    sesiones.set(id, lectura);
    return lectura;
  };

  let vistos: Promise<Record<string, number>> | null = null;
  const leeVigilantes = () => (vistos ??= turnoDeLectura(contarVigilantes).catch(() => ({})));
  const recuentaVigilantes = () => {
    vistos = null;
    sube();
  };

  // A write under a root names its session: `<id>/<n>.json` in tasks, `<folder>/<id>.jsonl` in projects. Only sessions some
  // client asked for wake anyone; the rest (sessions Paseo does not show) cost one map lookup.
  const olvida = (id: string) => {
    if (sesiones.delete(id)) sube();
  };
  const deTareas = (relativa: string) => olvida(relativa.split(sep)[0] ?? "");
  const deProyectos = (relativa: string) => {
    const partes = relativa.split(sep);
    if (partes.length !== 2 || !partes[1]!.endsWith(".jsonl")) return; // subagents' transcripts live deeper
    const id = partes[1]!.slice(0, -".jsonl".length);
    void indice?.then((mapa) => mapa.set(id, join(raices.projects, relativa)));
    olvida(id);
  };
  // A task file created or removed: a background task started or was cleaned up. Its output writes say nothing new, and a task
  // ending only closes the file (no event); that end wakes its agent, so the turn hooks recount then.
  const deSalidas = (evento: string, relativa: string) => {
    if (evento === "rename" && relativa.split(sep).at(-2) === "tasks") recuentaVigilantes();
  };

  const vigilantesFs: FSWatcher[] = [];
  const vigila = (raiz: string, cambio: (evento: string, relativa: string) => void) => {
    try {
      const w = watch(raiz, { recursive: true }, (evento, nombre) => {
        if (nombre) cambio(evento, String(nombre));
      });
      w.on("error", () => {}); // a root removed later stops reporting; the rest keep working
      vigilantesFs.push(w);
    } catch {
      // A root that does not exist yet (no Claude Code session on this host so far): nothing to report until there is.
    }
  };
  vigila(raices.tasks, (_evento, relativa) => deTareas(relativa));
  vigila(raices.projects, (_evento, relativa) => deProyectos(relativa));
  vigila(raices.salidas, deSalidas);

  const foto = async (pedidas: readonly string[]): Promise<Panel> => {
    const enVersion = version; // a change while reading moves the version past this: the client asks again
    const leidas = await Promise.all(pedidas.map(async (id) => [id, await leeSesion(id)] as const));
    const tareas: Panel["tareas"] = {};
    const contexto: Panel["contexto"] = {};
    const espera: Panel["espera"] = {};
    for (const [id, s] of leidas) {
      if (s.tareas.length > 0) tareas[id] = s.tareas;
      if (s.tokens !== null) contexto[id] = s.tokens;
      if (s.espera) espera[id] = s.espera;
    }
    return { tareas, contexto, espera, vigilantes: await leeVigilantes(), version: enVersion, changed: true };
  };

  return {
    async espera(pedidas, since) {
      if (since !== version) return foto(pedidas);
      const movida = await new Promise<boolean>((sigue) => {
        const despierta = () => {
          clearTimeout(limite);
          esperando.delete(despierta);
          sigue(true);
        };
        const limite = setTimeout(() => {
          esperando.delete(despierta);
          sigue(false);
        }, RETENCION_MS);
        esperando.add(despierta);
      });
      return movida ? foto(pedidas) : { tareas: {}, contexto: {}, espera: {}, vigilantes: {}, version, changed: false };
    },
    turno: recuentaVigilantes,
    cierra() {
      for (const w of vigilantesFs) w.close();
      if (aviso) clearTimeout(aviso);
      for (const despierta of [...esperando]) despierta();
    },
  };
}
