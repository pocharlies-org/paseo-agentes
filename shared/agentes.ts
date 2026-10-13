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
}

export type Grupo = "pregunta" | "marcha" | "sinVer";

const TITULOS: Record<Grupo, string> = { pregunta: "Te preguntan", marcha: "En marcha", sinVer: "Sin ver" };
const GRUPOS = Object.keys(TITULOS) as Grupo[];

/**
 * Paseo's own precedence (`deriveAgentStateBucket` of its protocol): a pending permission or question beats a running turn,
 * which beats an end nobody has opened yet. `requiresAttention` is cleared by Paseo when the agent is viewed.
 */
export function grupoDe(agente: Agente): Grupo | null {
  if (agente.pendingPermissions.length > 0 || agente.attentionReason === "permission") return "pregunta";
  if (agente.status === "running") return "marcha";
  return agente.requiresAttention ? "sinVer" : null;
}

/** The non-empty groups in that order, newest first by a time that stays put while an agent streams, so rows do not move under the pointer. */
export function agrupar<T extends Agente>(agentes: readonly T[]): { grupo: Grupo; titulo: string; agentes: T[] }[] {
  const desde = (agente: Agente) => agente.attentionTimestamp ?? agente.createdAt;
  return GRUPOS
    .map((grupo) => ({
      grupo,
      titulo: TITULOS[grupo],
      agentes: agentes.filter((agente) => grupoDe(agente) === grupo).sort((a, b) => desde(b).localeCompare(desde(a))),
    }))
    .filter((grupo) => grupo.agentes.length > 0);
}

/** What is folded: the whole block, and the groups closed inside it. */
export interface Plegado {
  readonly bloque: boolean;
  readonly grupos: readonly Grupo[];
}

/** The fold as stored, read defensively: the storage is shared with Paseo and anything else on its origin. */
export function leePlegado(texto: string | null): Plegado {
  let valor: { bloque?: unknown; grupos?: unknown } | null = null;
  try {
    valor = JSON.parse(texto ?? "null");
  } catch {
    // A broken value reads as nothing folded; the next fold overwrites it.
  }
  return {
    bloque: valor?.bloque === true,
    grupos: Array.isArray(valor?.grupos) ? valor.grupos.filter((grupo): grupo is Grupo => GRUPOS.includes(grupo)) : [],
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
