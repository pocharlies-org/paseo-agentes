import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SidebarRow, SidebarSeparator } from "@getpaseo/plugin/client/ui";
import { Fragment, useEffect, useMemo, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { agrupar, type Agente, type Grupo } from "../shared/agentes.ts";

// Paseo's row lets a bare glyph shrink when the title wraps to two lines; inside a View it keeps its size.
function icono(name: string) {
  return function Icono({ size, color }: { size: number; color: string }) {
    return (
      <View>
        <Icon name={name} size={size} color={color} />
      </View>
    );
  };
}

// The icons of Paseo's own status view.
const ICONOS: Record<Grupo, ReturnType<typeof icono>> = { pregunta: icono("CircleAlert"), marcha: icono("CircleDot"), sinVer: icono("CircleCheck") };
const ICONO_ERROR = icono("CircleX");

/**
 * The agents of every workspace of this host that ask something, run, or ended unseen, in the sidebar header. It follows the
 * agent directory with an owned subscription, as Paseo's local plugin example does: no polling.
 */
export function contributeAgentes(client: PluginClientContext): () => void {
  const agentes = new Map<string, Agente>();
  const avisos = new Set<() => void>();
  let foto: { agentes: Agente[]; error: string | null } = { agentes: [], error: null };
  const publica = (error: string | null = null) => {
    foto = { agentes: [...agentes.values()], error };
    for (const aviso of avisos) aviso();
  };
  const lifetime = new AbortController();
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          agentes.clear();
          for (const { agent } of entries) agentes.set(agent.id, agent);
          publica();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") agentes.delete(update.agentId);
          else agentes.set(update.agent.id, update.agent);
          publica();
        },
      });
    })
    // Said in the sidebar: an empty list would read as nothing pending.
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) publica(error instanceof Error ? error.message : String(error));
    });
  const suscribe = (aviso: () => void) => {
    avisos.add(aviso);
    return () => void avisos.delete(aviso);
  };
  const lee = () => foto;

  function AgentesItem({ theme, openScreen }: PluginSidebarItemProps) {
    const { agentes, error } = useSyncExternalStore(suscribe, lee);
    const grupos = useMemo(() => agrupar(agentes), [agentes]);
    if (!error && grupos.length === 0) return null;
    // Left edge of the rows' icons: the row's padding plus its button's.
    const cabecera = { color: theme.colors.foregroundMuted, fontSize: 11, paddingLeft: 16, paddingTop: 6, paddingBottom: 2 };
    return (
      <>
        <SidebarSeparator />
        <ScrollView style={{ maxHeight: 360 }}>
          {error ? <Text style={[cabecera, { color: theme.colors.statusDanger }]}>{`Agentes: ${error}`}</Text> : null}
          {grupos.map(({ grupo, titulo, agentes }) => (
            <Fragment key={grupo}>
              <Text style={cabecera}>{`${titulo} · ${agentes.length}`}</Text>
              {agentes.map((agente) => (
                <SidebarRow
                  key={agente.id}
                  id={agente.id}
                  icon={grupo === "sinVer" && agente.attentionReason === "error" ? ICONO_ERROR : ICONOS[grupo]}
                  label={agente.title ?? "Sin título"}
                  onPress={() => openScreen({ screenId: "abrir", params: { agentId: agente.id } })}
                />
              ))}
            </Fragment>
          ))}
        </ScrollView>
      </>
    );
  }

  client.addScreen({ id: "abrir", title: "Agente", Component: AbrirAgente });
  client.addSidebarHeaderItem({ id: "agentes", title: "Agentes", Component: AgentesItem });
  return () => lifetime.abort();
}

// shortcut: Paseo 0.11 gives `navigation.openAgent` to screens and panels, not to sidebar items, so a row opens this screen and the
// screen opens the agent; Paseo's workspace navigation pops back to the host route, so the screen does not stay in the history.
// Once PluginSidebarItemProps carries navigation, call openAgent from the row and drop this screen.
function AbrirAgente({ params, navigation, theme }: PluginScreenProps) {
  const agentId = params.agentId;
  useEffect(() => {
    if (agentId) navigation?.openAgent({ agentId });
  }, [agentId, navigation]);
  if (navigation) return null;
  return <Text style={{ color: theme.colors.foregroundMuted, padding: 24 }}>Esta versión de Paseo no deja abrir un agente desde un plugin.</Text>;
}
