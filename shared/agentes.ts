/** The fields of a Paseo agent (`AgentSnapshotPayload`) this plugin reads. */
export interface Agente {
  readonly id: string;
  readonly title: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly pendingPermissions: readonly unknown[];
  readonly requiresAttention?: boolean;
  readonly attentionReason?: "finished" | "error" | "permission" | null;
  readonly attentionTimestamp?: string | null;
  readonly workspaceId?: string;
  readonly projectId?: string | null;
  readonly updatedAt?: string;
  readonly activeTurn?: { readonly startedAt: string | null } | null;
  readonly labels?: Readonly<Record<string, string>>;
  readonly persistence?: { readonly sessionId: string } | null;
  readonly runtimeInfo?: { readonly sessionId: string | null };
}

// The same buckets and Spanish labels as Paseo's status view (`STATUS_BUCKET_ORDER` and `statusBucket` in its i18n).
export type Grupo = "necesitaDatos" | "conError" | "paraRevisar" | "enEjecucion" | "terminado";

const TITULOS: Record<Grupo, string> = {
  necesitaDatos: "Necesita datos",
  conError: "Con error",
  paraRevisar: "Para revisar",
  enEjecucion: "En ejecución",
  terminado: "Terminado",
};
const GRUPOS = Object.keys(TITULOS) as Grupo[];

/**
 * Paseo's own precedence (`deriveAgentStateBucket` of its protocol): data it needs beats an error, which beats a running
 * turn, which beats an end nobody has opened yet; everything else is done. `requiresAttention` is cleared by Paseo when
 * the agent is viewed. `enMarcha`: something of the agent's still runs (a child agent or a Claude subagent).
 */
export function grupoDe(agente: Agente, enMarcha = false): Grupo {
  if (agente.pendingPermissions.length > 0 || agente.attentionReason === "permission") return "necesitaDatos";
  if (agente.status === "error" || agente.attentionReason === "error") return "conError";
  if (agente.status === "running" || enMarcha) return "enEjecucion";
  return agente.requiresAttention ? "paraRevisar" : "terminado";
}

const PADRE = "paseo.parent-agent-id";

/**
 * Paseo's `resolveWorkspaceRootAgent` (server workspace-directory.ts): up through parents while they share the workspace.
 * A child in another workspace is a root there; one whose parent is gone (archived) belongs to no one.
 */
export function raizDe<T extends Agente>(agente: T, porId: ReadonlyMap<string, T>): T | null {
  const vistos = new Set([agente.id]);
  let actual = agente;
  for (;;) {
    const padreId = actual.labels?.[PADRE];
    if (!padreId) return actual;
    const padre = porId.get(padreId);
    if (!padre || vistos.has(padreId)) return null;
    if (padre.workspaceId !== actual.workspaceId) return actual;
    vistos.add(padreId);
    actual = padre;
  }
}

export interface GrupoDe<T extends Agente> {
  readonly grupo: Grupo;
  readonly titulo: string;
  readonly agentes: T[];
}

/** The rows and what runs inside them, by the rules of Paseo's workspace status (server workspace-directory.ts). */
function filasDe<T extends Agente>(
  agentes: readonly T[],
  conSubagentes: { has(agentId: string): boolean },
): { filas: T[]; enMarcha: Set<string> } {
  const porId = new Map(agentes.map((agente) => [agente.id, agente]));
  const enMarcha = new Set<string>();
  for (const agente of agentes) {
    const raiz = raizDe(agente, porId);
    if (raiz && (conSubagentes.has(agente.id) || (raiz !== agente && agente.status === "running"))) enMarcha.add(raiz.id);
  }
  return { filas: agentes.filter((agente) => raizDe(agente, porId) === agente), enMarcha };
}

/** The non-empty groups in order, newest first by a time that stays put while an agent streams, so rows do not move under the pointer. */
function gruposDe<T extends Agente>(filas: readonly T[], enMarcha: ReadonlySet<string>): GrupoDe<T>[] {
  const desde = (agente: Agente) => agente.attentionTimestamp ?? agente.createdAt;
  return GRUPOS.map((grupo) => ({
    grupo,
    titulo: TITULOS[grupo],
    agentes: filas
      .filter((agente) => grupoDe(agente, enMarcha.has(agente.id)) === grupo)
      .sort((a, b) => desde(b).localeCompare(desde(a))),
  })).filter((grupo) => grupo.agentes.length > 0);
}

/**
 * The rows by the rules of Paseo's workspace status, so this block and the status view agree: only workspace roots are rows;
 * a running child in the same workspace, or a running Claude subagent of the agent or of such a child (`conSubagentes`: their
 * parent agent ids), makes the root running.
 */
export function agrupar<T extends Agente>(
  agentes: readonly T[],
  conSubagentes: { has(agentId: string): boolean } = new Set(),
): GrupoDe<T>[] {
  const { filas, enMarcha } = filasDe(agentes, conSubagentes);
  return gruposDe(filas, enMarcha);
}

/** The fields of a Paseo workspace (`WorkspaceDescriptorPayload`) its sidebar row is drawn from; its status is the daemon's own. */
export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly status: "needs_input" | "failed" | "running" | "attention" | "done";
  readonly statusEnteredAt: string | null;
}

// Paseo's urgency order (`STATUS_BUCKET_PRIORITY` in app utils/sidebar-agent-state.ts): what needs you first, then what
// failed, then what is moving. A workspace the daemon has not described yet sits behind every described one.
const RANGO: Record<Workspace["status"], number> = { needs_input: 0, failed: 1, running: 2, attention: 3, done: 4 };

/**
 * Rows grouped by workspace, and inside each workspace by status group: the native sidebar's level over this plugin's groups.
 * `agrupar` and this share `filasDe`, so a root is a row in exactly one of the two.
 */
export function porWorkspace<T extends Agente>(
  agentes: readonly T[],
  conSubagentes: { has(agentId: string): boolean } = new Set(),
  workspaces: ReadonlyMap<string, Workspace> = new Map(),
): { workspace: Workspace | null; grupos: GrupoDe<T>[] }[] {
  const { filas, enMarcha } = filasDe(agentes, conSubagentes);
  const porId = new Map<string | null, T[]>();
  for (const fila of filas) {
    const clave = fila.workspaceId ?? null;
    const grupo = porId.get(clave);
    if (grupo) grupo.push(fila);
    else porId.set(clave, [fila]);
  }
  const rango = (id: string | null) => (id && workspaces.has(id) ? RANGO[workspaces.get(id)!.status] : GRUPOS.length);
  const desde = (id: string | null) => (id ? workspaces.get(id)?.statusEnteredAt ?? "" : "");
  return [...porId]
    .sort(([a, fa], [b, fb]) => rango(a) - rango(b) || desde(b).localeCompare(desde(a)) || fb.length - fa.length)
    .map(([id, filasDelWorkspace]) => ({
      workspace: id ? workspaces.get(id) ?? null : null,
      grupos: gruposDe(filasDelWorkspace, enMarcha),
    }));
}

export interface BloqueDeProyecto<T extends Agente> {
  readonly proyecto: Proyecto | null;
  readonly workspaces: { workspace: Workspace | null; grupos: GrupoDe<T>[] }[];
}

/**
 * Rows grouped by project, then by workspace, then by status group — the native sidebar's two levels over this plugin's groups.
 * A project ranks by its most urgent workspace (and its newest status), so the project asking for you comes first.
 */
export function porProyecto<T extends Agente>(
  agentes: readonly T[],
  conSubagentes: { has(agentId: string): boolean } = new Set(),
  workspaces: ReadonlyMap<string, Workspace> = new Map(),
  proyectos: readonly Proyecto[] = [],
): BloqueDeProyecto<T>[] {
  const { filas } = filasDe(agentes, conSubagentes);
  const nombres = new Map(proyectos.map((proyecto) => [proyecto.projectId, proyecto]));
  const proyectoDe = (fila: T) => fila.projectId ?? (fila.workspaceId ? workspaces.get(fila.workspaceId)?.projectId ?? null : null);
  const porProy = new Map<string | null, T[]>();
  for (const fila of filas) {
    const clave = proyectoDe(fila);
    const grupo = porProy.get(clave);
    if (grupo) grupo.push(fila);
    else porProy.set(clave, [fila]);
  }
  const rango = (filasP: readonly T[]) =>
    filasP.reduce(
      (mejor, fila) => Math.min(mejor, fila.workspaceId && workspaces.has(fila.workspaceId) ? RANGO[workspaces.get(fila.workspaceId)!.status] : GRUPOS.length),
      GRUPOS.length + 1,
    );
  const desde = (filasP: readonly T[]) =>
    filasP.reduce((mejor, fila) => {
      const d = fila.workspaceId ? workspaces.get(fila.workspaceId)?.statusEnteredAt ?? "" : "";
      return d > mejor ? d : mejor;
    }, "");
  const nombre = (id: string | null) => (id ? nombres.get(id)?.projectCustomName ?? nombres.get(id)?.projectDisplayName ?? "" : "");
  return [...porProy]
    .sort(([a, fa], [b, fb]) => rango(fa) - rango(fb) || desde(fb).localeCompare(desde(fa)) || nombre(a).localeCompare(nombre(b)))
    .map(([id, filasP]) => ({
      proyecto: id ? nombres.get(id) ?? null : null,
      workspaces: porWorkspace(filasP, conSubagentes, workspaces),
    }));
}

/** What a row has running in the background: Claude subagents and Claude Code tasks (watchers). */
export interface EnMarcha {
  readonly subagentes: number;
  readonly vigilantes: number;
}

/**
 * Per row, what runs in the background for the agent and the children folded into it. `subagentes`: running Claude subagents
 * per agent id; `vigilantes`: running Claude Code tasks per Claude session id.
 */
export function enMarchaPorFila<T extends Agente>(
  agentes: readonly T[],
  subagentes: ReadonlyMap<string, number>,
  vigilantes: Readonly<Record<string, number>>,
): Map<string, EnMarcha> {
  const porId = new Map(agentes.map((agente) => [agente.id, agente]));
  const porFila = new Map<string, EnMarcha>();
  for (const agente of agentes) {
    const raiz = raizDe(agente, porId);
    const sesion = agente.persistence?.sessionId ?? agente.runtimeInfo?.sessionId;
    const enMarcha = { subagentes: subagentes.get(agente.id) ?? 0, vigilantes: (sesion && vigilantes[sesion]) || 0 };
    if (!raiz || enMarcha.subagentes + enMarcha.vigilantes === 0) continue;
    const previo = porFila.get(raiz.id);
    porFila.set(
      raiz.id,
      previo ? { subagentes: previo.subagentes + enMarcha.subagentes, vigilantes: previo.vigilantes + enMarcha.vigilantes } : enMarcha,
    );
  }
  return porFila;
}

/** How long ago `desde` was, in one word beside the row: «ahora» under a minute, then «5m», «2h», «3d». */
export function hace(desde: string | null | undefined, ahora: number): string | null {
  const ms = desde ? ahora - Date.parse(desde) : NaN;
  // No time, or the client clock ahead of the daemon's: say nothing rather than a wrong «ahora».
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutos = Math.floor(ms / 60_000);
  if (minutos < 1) return "ahora";
  if (minutos < 60) return `${minutos}m`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `${horas}h`;
  return `${Math.floor(horas / 24)}d`;
}

/** What is folded: the whole block, the groups closed inside it, the workspaces and projects closed in the workspace grouping, and the projects filtered out. */
export interface Plegado {
  readonly bloque: boolean;
  readonly grupos: readonly Grupo[];
  readonly workspaces: readonly string[];
  readonly proyectos: readonly string[];
  readonly ocultos: readonly string[];
}

/** The fold as stored, read defensively: the storage is shared with Paseo and anything else on its origin. */
export function leePlegado(texto: string | null): Plegado {
  let valor: { bloque?: unknown; grupos?: unknown; workspaces?: unknown; proyectos?: unknown; ocultos?: unknown } | null = null;
  try {
    valor = JSON.parse(texto ?? "null");
  } catch {
    // A broken value reads as nothing folded; the next fold overwrites it.
  }
  const grupos = Array.isArray(valor?.grupos) ? valor.grupos.filter((grupo): grupo is Grupo => GRUPOS.includes(grupo)) : [];
  // "Terminado" arrived later: with nothing stored, or a save from before it existed, it starts folded so the block does not flood.
  const anterior = valor === null || valor.ocultos === undefined;
  const cadenas = (v: unknown) => (Array.isArray(v) ? v.filter((clave): clave is string => typeof clave === "string") : []);
  return {
    bloque: valor?.bloque === true,
    grupos: anterior && !grupos.includes("terminado") ? [...grupos, "terminado"] : grupos,
    workspaces: cadenas(valor?.workspaces),
    proyectos: cadenas(valor?.proyectos),
    ocultos: cadenas(valor?.ocultos),
  };
}

/** The fields of a Paseo project (`WorkspaceProjectDescriptorPayload`) its sidebar icon is drawn from. */
export interface Proyecto {
  readonly projectId: string;
  readonly projectKey?: string;
  readonly projectDisplayName: string;
  readonly projectCustomName?: string | null;
}

/** A project's icon as Paseo's workspace list draws it when the project has no image: its initial on its color. */
export interface Insignia {
  readonly inicial: string;
  readonly color: string;
}

// Paseo's palette (`IDENTITY_COLOR_NAMES` in app/src/styles/identity-colors.ts); its order is load-bearing, the hash indexes it.
const COLORES = ["#7a6aa8", "#3d7ea6", "#388068", "#a4673a", "#b05c80", "#6a70b8", "#368080", "#b06260", "#8f7838", "#5179b0"];

/**
 * The icon of each project of one host, by projectId, derived as Paseo's sidebar does (app/src/projects/workspace-structure.ts,
 * styles/identity-colors.ts, utils/project-display-name.ts): the color hashes the projectKey when no other project of the host
 * shares it, else the host and the projectId; the initial is that of the last path segment of the custom name, else the display name.
 */
export function insignias(serverId: string, proyectos: readonly Proyecto[]): Map<string, Insignia> {
  const usos = new Map<string, number>();
  for (const { projectKey } of proyectos) if (projectKey) usos.set(projectKey, (usos.get(projectKey) ?? 0) + 1);
  return new Map(
    proyectos.map((proyecto) => {
      const { projectKey } = proyecto;
      const clave = projectKey && usos.get(projectKey) === 1 ? projectKey : JSON.stringify([serverId, proyecto.projectId]);
      let hash = 0;
      for (const letra of clave) hash = (hash * 31 + letra.charCodeAt(0)) >>> 0;
      const nombre = (proyecto.projectCustomName ?? proyecto.projectDisplayName).trim();
      const inicial = (nombre.split("/").filter(Boolean).at(-1) ?? nombre).charAt(0).toUpperCase();
      return [proyecto.projectId, { inicial, color: COLORES[hash % COLORES.length]! }];
    }),
  );
}
