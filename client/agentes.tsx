import type { PluginClientContext, PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SidebarRow, SidebarSeparator } from "@getpaseo/plugin/client/ui";
import { Fragment, useEffect, useMemo, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { agrupar, insignias, leePlegado, type Agente, type Grupo, type Insignia, type Plegado, type Proyecto } from "../shared/agentes.ts";

type Dibujo = (props: { size: number; color: string }) => React.JSX.Element;

// Paseo's row lets a bare glyph shrink when the title wraps to two lines; inside a View it keeps its size.
function icono(name: string): Dibujo {
  return function Icono({ size, color }) {
    return (
      <View>
        <Icon name={name} size={size} color={color} />
      </View>
    );
  };
}

// The icons of Paseo's own status view.
const ICONOS: Record<Grupo, Dibujo> = { pregunta: icono("CircleAlert"), marcha: icono("CircleDot"), sinVer: icono("CircleCheck") };
const ICONO_ERROR = icono("CircleX");
const ABIERTO = icono("ChevronDown");
const CERRADO = icono("ChevronRight");

// A row's icon has to be a component: one per initial and color, so a row keeps its element across renders.
const dibujos = new Map<string, Dibujo>();
function dibujo({ inicial, color }: Insignia): Dibujo {
  const clave = `${color}${inicial}`;
  let dibujado = dibujos.get(clave);
  if (!dibujado) {
    // Paseo's ProjectIconView: a square with a quarter-size radius and a white letter.
    dibujado = function InsigniaDeProyecto({ size }) {
      return (
        <View style={{ width: size, height: size, borderRadius: Math.round(size / 4), backgroundColor: color, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: "#ffffff", fontSize: 9 }}>{inicial}</Text>
        </View>
      );
    };
    dibujos.set(clave, dibujado);
  }
  return dibujado;
}

/** An agent and its project: the agent directory's placement `projectKey` carries the projectId. */
type Fila = Agente & { readonly projectId: string | null };

interface Foto {
  readonly agentes: readonly Fila[];
  readonly proyectos: readonly Proyecto[];
  readonly plegado: Plegado;
  readonly error: string | null;
}

const CLAVE_PLEGADO = "paseo-agentes:plegado";
// The fold outlives a reload where there is localStorage (web and desktop); on the phone it lasts until the app closes.
const almacen = (globalThis as { localStorage?: { getItem(clave: string): string | null; setItem(clave: string, valor: string): void } })
  .localStorage;

export function contributeAgentes(client: PluginClientContext): () => void {
  const filas = new Map<string, Fila>();
  const avisos = new Set<() => void>();
  let foto: Foto = { agentes: [], proyectos: [], plegado: leePlegado(almacen?.getItem(CLAVE_PLEGADO) ?? null), error: null };
  const publica = (cambio: Partial<Foto>) => {
    foto = { ...foto, ...cambio };
    for (const aviso of avisos) aviso();
  };
  const muestraFilas = () => publica({ agentes: [...filas.values()] });
  const lifetime = new AbortController();
  // Said in the sidebar: an empty list would read as nothing pending.
  const falla = (error: unknown) => {
    if (!lifetime.signal.aborted) publica({ error: error instanceof Error ? error.message : String(error) });
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          filas.clear();
          for (const { agent, project } of entries) filas.set(agent.id, { ...agent, projectId: project.projectKey });
          muestraFilas();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") filas.delete(update.agentId);
          else {
            const projectId = update.project?.projectKey ?? filas.get(update.agent.id)?.projectId ?? null;
            filas.set(update.agent.id, { ...update.agent, projectId });
          }
          muestraFilas();
        },
      });
    })
    .catch(falla);

  // Re-read whole on every project event: they are rare, and a full list cannot drift the way patched entries can.
  const leeProyectos = () => client.paseo.projects.list().then(({ projects }) => publica({ proyectos: projects }), falla);
  const sueltaProyectos = client.paseo.projects.subscribe(() => void leeProyectos());
  void leeProyectos();

  const suscribe = (aviso: () => void) => {
    avisos.add(aviso);
    return () => void avisos.delete(aviso);
  };
  const lee = () => foto;
  const pliega = (plegado: Plegado) => {
    publica({ plegado });
    almacen?.setItem(CLAVE_PLEGADO, JSON.stringify(plegado));
  };

  function AgentesItem({ theme, host, openScreen }: PluginSidebarItemProps) {
    const { agentes, proyectos, plegado, error } = useSyncExternalStore(suscribe, lee);
    const grupos = useMemo(() => agrupar(agentes), [agentes]);
    const iconos = useMemo(() => insignias(host.id, proyectos), [host.id, proyectos]);
    const { height } = useWindowDimensions();
    if (!error && grupos.length === 0) return null;
    const tenue = theme.colors.foregroundMuted;
    const texto = { color: tenue, fontSize: 11 };
    // Left edge of the rows' icons: the row's padding plus its button's.
    const sangria = { paddingLeft: 16, paddingTop: 6, paddingBottom: 2 };
    const linea = { ...sangria, flexDirection: "row", alignItems: "center", gap: 4 } as const;
    const Pliegue = plegado.bloque ? CERRADO : ABIERTO;
    return (
      <>
        <SidebarSeparator />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: !plegado.bloque }}
          onPress={() => pliega({ ...plegado, bloque: !plegado.bloque })}
          style={[linea, { paddingRight: 16 }]}
        >
          <Pliegue size={12} color={tenue} />
          <Text style={[texto, { flex: 1 }]}>Agentes</Text>
          {grupos.map(({ grupo, agentes }) => {
            const Simbolo = ICONOS[grupo];
            return (
              <View key={grupo} style={{ flexDirection: "row", alignItems: "center", gap: 2, marginLeft: 6 }}>
                <Simbolo size={12} color={tenue} />
                <Text style={texto}>{agentes.length}</Text>
              </View>
            );
          })}
        </Pressable>
        {error ? <Text style={[texto, sangria, { color: theme.colors.statusDanger }]}>{`Agentes: ${error}`}</Text> : null}
        {plegado.bloque ? null : (
          <ScrollView style={{ maxHeight: Math.round(height * 0.6) }}>
            {grupos.map(({ grupo, titulo, agentes }) => {
              const abierto = !plegado.grupos.includes(grupo);
              const Flecha = abierto ? ABIERTO : CERRADO;
              return (
                <Fragment key={grupo}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: abierto }}
                    onPress={() =>
                      pliega({ ...plegado, grupos: abierto ? [...plegado.grupos, grupo] : plegado.grupos.filter((otro) => otro !== grupo) })
                    }
                    style={linea}
                  >
                    <Flecha size={12} color={tenue} />
                    <Text style={texto}>{`${titulo} · ${agentes.length}`}</Text>
                  </Pressable>
                  {abierto
                    ? agentes.map((agente) => {
                        const insignia = agente.projectId ? iconos.get(agente.projectId) : undefined;
                        return (
                          <SidebarRow
                            key={agente.id}
                            id={agente.id}
                            icon={insignia ? dibujo(insignia) : ICONOS[grupo]}
                            label={agente.title ?? "Sin título"}
                            onPress={() => openScreen({ screenId: "abrir", params: { agentId: agente.id } })}
                            trailing={
                              grupo === "sinVer" && agente.attentionReason === "error" ? (
                                <ICONO_ERROR size={14} color={theme.colors.statusDanger} />
                              ) : undefined
                            }
                          />
                        );
                      })
                    : null}
                </Fragment>
              );
            })}
          </ScrollView>
        )}
      </>
    );
  }

  client.addScreen({ id: "abrir", title: "Agente", Component: AbrirAgente });
  client.addSidebarHeaderItem({ id: "agentes", title: "Agentes", Component: AgentesItem });
  return () => {
    lifetime.abort();
    sueltaProyectos();
  };
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
