import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { Panel, Sesion } from "../shared/contract.ts";
import { esperaDe, leeCola, tareas as leeTareas, tokensDeContexto } from "./contexto.ts";
import { vigilantes } from "./vigilantes.ts";

/**
 * The panel's data that Paseo has no event for — Claude Code's task lists and transcripts, and the watchers holding task files
 * open — kept in one cache that only a change touches (SC-5601). The PR of each workspace is not here: Paseo's own forge
 * observer sends it with every workspace update (`githubRuntime`). Two recursive inotify watches say which session a write
 * belongs to; that session alone is read again, and the version moves only when its tasks or closing line changed. Its tokens
 * alone move no version (SC-5849): a running turn changes them on every reply, and its row already shows the provider's live
 * count; the new count rides along with the session's next move and with every complete answer. Each held call answers only
 * the sessions it asked for that moved after its `since`, so a client is not woken by another's sessions and never receives
 * the whole panel twice. The watchers of a session are counted again only when its turn ends (SC-5923): every foreground
 * command also holds a task file while it runs, so a count during the turn would wake every client twice per command.
 */

const RETENCION_MS = 20_000; // a held call answers by then: under the daemon's 30 s plugin request timeout
const AVISO_MS = 2_000; // a running turn writes its transcript many times a second: it is read again at most this often
const LECTURAS = 4; // reads of files or processes at once
const REPOSO_MS = 60_000; // no held call for this long = no client shows the panel: the watches close (Dani 18-11)

export interface Raices {
  readonly tasks: string;
  readonly projects: string;
}

const raicesPorDefecto = (): Raices => ({
  tasks: join(homedir(), ".claude", "tasks"),
  projects: join(homedir(), ".claude", "projects"),
});

/** What is shown, and the version of its last visible change (a session's tokens alone are not one). */
interface Entrada<T> {
  datos: T;
  cambio: number;
}

export interface Vigilia {
  /** The asked sessions that moved after `since`: at once when there are some, else when one moves or the hold expires. */
  espera(sesiones: readonly string[], since: number): Promise<Panel>;
  /** The session's turn ended: its foreground commands are over, so the task files it still holds are its watchers. */
  turno(sesion: string): void;
  /** Some client showed the panel within REPOSO_MS: the watches are open. */
  activa(): boolean;
  cierra(): void;
}

export function vigilia(
  raices: Raices = raicesPorDefecto(),
  contarVigilantes: () => Promise<Record<string, number>> = () => vigilantes(),
  reposoMs = REPOSO_MS,
): Vigilia {
  // A `since` from before this instance (the plugin was reloaded) is older than its start: that caller gets everything again.
  let inicio = Date.now();
  let version = inicio;
  let cerrada = false;
  const esperando = new Set<() => void>();
  const despierta = () => {
    for (const sigue of [...esperando]) sigue();
  };
  const retiene = (ms: number) =>
    new Promise<boolean>((sigue) => {
      const movida = () => {
        clearTimeout(limite);
        esperando.delete(movida);
        sigue(true);
      };
      const limite = setTimeout(() => {
        esperando.delete(movida);
        sigue(false);
      }, ms);
      esperando.add(movida);
    });

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

  const vacia: Sesion = { tareas: [], tokens: null, espera: null };
  const leeSesion = (id: string): Promise<Sesion> =>
    turnoDeLectura(async () => {
      const ruta = (await transcripts()).get(id);
      const suelta = ruta ? await leeCola(ruta) : null;
      return { tareas: await leeTareas(id, raices.tasks), tokens: suelta === null ? null : tokensDeContexto(suelta), espera: suelta === null ? null : esperaDe(suelta) };
    }).catch(() => vacia); // the session's next write reads it again

  // Only sessions some client asked for are kept, and only those are read again on a write: the rest cost one map lookup.
  const sesiones = new Map<string, Promise<Entrada<Sesion>>>();
  const entrada = (id: string) => {
    let hecha = sesiones.get(id);
    if (!hecha) {
      hecha = leeSesion(id).then((datos) => ({ datos, cambio: version }));
      sesiones.set(id, hecha);
    }
    return hecha;
  };
  let vistos: Promise<Entrada<Record<string, number>>> | null = null;
  const leeVigilantes = () => turnoDeLectura(contarVigilantes).catch((): Record<string, number> => ({}));
  const entradaVigilantes = () => (vistos ??= leeVigilantes().then((datos) => ({ datos, cambio: version })));

  // What a write marked is read again together, at most every AVISO_MS; the version moves once per thing whose change a client shows.
  const sucias = new Set<string>();
  const recontar = new Set<string>(); // sessions whose turn ended: only their counts are taken from the next scan
  let ronda: ReturnType<typeof setTimeout> | null = null;
  let ultimaRonda = 0;
  const programa = () => {
    if (!cerrada) ronda ??= setTimeout(() => void revisa(), Math.max(0, ultimaRonda + AVISO_MS - Date.now()));
  };
  const revisa = async () => {
    ultimaRonda = Date.now();
    const ids = [...sucias];
    sucias.clear();
    const recontadas = vistos === null ? [] : [...recontar]; // no count kept yet: the first call scans everything
    recontar.clear();
    let movida = false;
    await Promise.all(
      ids.map(async (id) => {
        const antes = await sesiones.get(id);
        if (!antes) return;
        const leida = await leeSesion(id);
        // A big tool result can push the last `usage` out of the tail read: that is no count, so the last one stays.
        const datos = { ...leida, tokens: leida.tokens ?? antes.datos.tokens };
        if (JSON.stringify(datos) === JSON.stringify(antes.datos)) return;
        const visible = JSON.stringify(datos.tareas) !== JSON.stringify(antes.datos.tareas) || datos.espera !== antes.datos.espera;
        sesiones.set(id, Promise.resolve({ datos, cambio: visible ? ++version : antes.cambio }));
        if (visible) movida = true;
      }),
    );
    if (recontadas.length > 0) {
      const antes = await vistos!;
      const leidos = await leeVigilantes();
      // shortcut: a turn that starts again before this scan (≤ AVISO_MS) has its first foreground command counted until it
      // ends; upgrade by dropping sessions whose turn started meanwhile if that shows.
      const datos = { ...antes.datos };
      for (const sesion of recontadas) {
        if (leidos[sesion]) datos[sesion] = leidos[sesion];
        else delete datos[sesion];
      }
      if (JSON.stringify(datos) !== JSON.stringify(antes.datos)) {
        vistos = Promise.resolve({ datos, cambio: ++version });
        movida = true;
      }
    }
    ronda = null; // writes during the reads were marked: they get the next round
    if (sucias.size > 0 || recontar.size > 0) programa();
    if (movida) despierta();
  };

  // A write under a root names its session: `<id>/<n>.json` in tasks, `<folder>/<id>.jsonl` in projects.
  const marca = (id: string) => {
    if (!sesiones.has(id)) return;
    sucias.add(id);
    programa();
  };
  const deProyectos = (relativa: string) => {
    const partes = relativa.split(sep);
    if (partes.length !== 2 || !partes[1]!.endsWith(".jsonl")) return; // subagents' transcripts live deeper
    const id = partes[1]!.slice(0, -".jsonl".length);
    void indice?.then((mapa) => mapa.set(id, join(raices.projects, relativa)));
    marca(id);
  };

  const vigilantesFs: FSWatcher[] = [];
  const vigila = (raiz: string, cambio: (relativa: string) => void) => {
    try {
      const w = watch(raiz, { recursive: true }, (_evento, nombre) => {
        if (nombre) cambio(String(nombre));
      });
      w.on("error", () => {}); // a root removed later stops reporting; the rest keep working
      vigilantesFs.push(w);
    } catch {
      // A root that does not exist yet (no Claude Code session on this host so far): nothing to report until there is.
    }
  };
  // Nothing is watched until a client asks, and the watches close when none has asked for REPOSO_MS: what was kept is dropped
  // with them (no write would mark it any more), and the version jumps so the next caller's `since` reads as a new instance.
  let abierta = false;
  let enCurso = 0;
  let reposo: ReturnType<typeof setTimeout> | null = null;
  const abre = () => {
    if (reposo) clearTimeout(reposo);
    reposo = null;
    if (abierta || cerrada) return;
    abierta = true;
    vigila(raices.tasks, (relativa) => marca(relativa.split(sep)[0] ?? ""));
    vigila(raices.projects, deProyectos);
  };
  const duerme = () => {
    reposo = null;
    abierta = false;
    for (const w of vigilantesFs.splice(0)) w.close();
    if (ronda) clearTimeout(ronda);
    ronda = null;
    sucias.clear();
    recontar.clear();
    sesiones.clear();
    indice = null;
    vistos = null;
    inicio = version = Math.max(version + 1, Date.now());
  };

  const foto = async (pedidas: readonly string[], since: number): Promise<Panel> => {
    const enVersion = version; // a change while reading has a later version: the next call brings it (at worst twice)
    const completo = since < inicio || since > version;
    const leidas = await Promise.all(pedidas.map(async (id) => [id, await entrada(id)] as const));
    const vistosAhora = await entradaVigilantes();
    const movidas: Panel["sesiones"] = {};
    for (const [id, { datos, cambio }] of leidas) if (completo || cambio > since) movidas[id] = datos;
    return { sesiones: movidas, ...(completo || vistosAhora.cambio > since ? { vigilantes: vistosAhora.datos } : {}), version: enVersion, completo };
  };

  return {
    async espera(pedidas, since) {
      abre();
      enCurso++;
      try {
        return await sostiene(pedidas, since);
      } finally {
        if (--enCurso === 0 && !cerrada) reposo = setTimeout(duerme, reposoMs);
      }
    },
    turno(sesion) {
      if (!abierta) return; // nobody shows the counts: the next panel call scans everything anyway
      recontar.add(sesion);
      programa();
    },
    activa: () => abierta,
    cierra() {
      cerrada = true;
      if (reposo) clearTimeout(reposo);
      for (const w of vigilantesFs) w.close();
      if (ronda) clearTimeout(ronda);
      despierta();
    },
  };

  async function sostiene(pedidas: readonly string[], since: number): Promise<Panel> {
    const hasta = Date.now() + RETENCION_MS;
    for (;;) {
      if (since !== version) {
        const panel = await foto(pedidas, since);
        if (panel.completo || panel.vigilantes || Object.keys(panel.sesiones).length > 0) return panel;
        since = panel.version; // what moved was other clients' sessions: keep holding from here
      }
      const queda = hasta - Date.now();
      if (cerrada || queda <= 0 || !(await retiene(queda))) return { sesiones: {}, version: since, completo: false };
    }
  }
}
