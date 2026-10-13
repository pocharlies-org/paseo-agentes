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
  return (Object.keys(TITULOS) as Grupo[])
    .map((grupo) => ({
      grupo,
      titulo: TITULOS[grupo],
      agentes: agentes.filter((agente) => grupoDe(agente) === grupo).sort((a, b) => desde(b).localeCompare(desde(a))),
    }))
    .filter((grupo) => grupo.agentes.length > 0);
}
