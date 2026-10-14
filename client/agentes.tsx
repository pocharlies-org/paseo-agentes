import type {
  PluginClientContext,
  PluginHostProps,
  PluginScreenProps,
  PluginSidebarItemProps,
  PluginSurfaceProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection, SettingsSelect, SidebarRow, SidebarSeparator } from "@getpaseo/plugin/client/ui";
import { Fragment, useEffect, useMemo, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import {
  agrupar,
  enMarchaPorFila,
  insignias,
  leePlegado,
  type Agente,
  type EnMarcha,
  type Grupo,
  type Insignia,
  type Plegado,
  type Proyecto,
} from "../shared/agentes.ts";
import { ajustesAgentes, type Lado } from "../shared/ajustes.ts";
import { ladoGet, vigilantesList } from "../shared/contract.ts";

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
const ICONOS: Record<Grupo, Dibujo> = {
  necesitaDatos: icono("CircleAlert"),
  conError: icono("CircleX"),
  paraRevisar: icono("CircleCheck"),
  enEjecucion: icono("CircleDot"),
  terminado: icono("Check"),
};
const ICONO_SIN_PROYECTO = icono("Circle");
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
  /** Running Claude subagents per agent id: Paseo's status view counts their agents as running. */
  readonly subagentes: ReadonlyMap<string, number>;
  /** Running Claude Code tasks (watchers) per Claude session id, read on the daemon host. */
  readonly vigilantes: Readonly<Record<string, number>>;
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
  let foto: Foto = { agentes: [], subagentes: new Map(), vigilantes: {}, proyectos: [], plegado: leePlegado(almacen?.getItem(CLAVE_PLEGADO) ?? null), error: null };
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

  // Watchers have no event: they start inside a turn and their end wakes the agent, so a change of agents is when to look again.
  // At most one read every 3 s (a scan of /proc costs ~150 ms on the host).
  let leyendo = false;
  let otraVez = false;
  const leeVigilantes = () => {
    if (lifetime.signal.aborted) return;
    if (leyendo) {
      otraVez = true;
      return;
    }
    leyendo = true;
    void client
      .rpc(vigilantesList, {})
      .then(({ sesiones }) => publica({ vigilantes: sesiones }), falla)
      .finally(() =>
        setTimeout(() => {
          leyendo = false;
          if (otraVez) {
            otraVez = false;
            leeVigilantes();
          }
        }, 3000),
      );
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          filas.clear();
          for (const { agent, project } of entries) filas.set(agent.id, { ...agent, projectId: project.projectKey });
          muestraFilas();
          leeVigilantes();
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
          leeVigilantes();
        },
      });
    })
    .catch(falla);

  // Re-read whole on every project event: they are rare, and a full list cannot drift the way patched entries can.
  const leeProyectos = () => client.paseo.projects.list().then(({ projects }) => publica({ proyectos: projects }), falla);
  const sueltaProyectos = client.paseo.projects.subscribe(() => void leeProyectos());
  void leeProyectos();

  // Running Claude subagents (Task tool and workflows; background shells are not subagents for Paseo either), by parent and id.
  // shortcut: the event stream has no snapshot, so a subagent already running when this loads shows from its next action or
  // its end; upgrade if the plugin API gets a subagent list.
  const subagentes = new Map<string, string>();
  const muestraSubagentes = () => {
    const porAgente = new Map<string, number>();
    for (const padre of subagentes.values()) porAgente.set(padre, (porAgente.get(padre) ?? 0) + 1);
    publica({ subagentes: porAgente });
  };
  client.paseo.observeEvents(["agent.provider_subagents.update"], { signal: lifetime.signal }).subscribe({
    // Delivered again after a reconnect: whatever ended meanwhile must not stay running.
    snapshot: () => {
      subagentes.clear();
      muestraSubagentes();
    },
    update: (message) => {
      if (message.type !== "agent.provider_subagents.update") return;
      const update = message.payload;
      if (update.kind === "upsert") {
        const clave = `${update.subagent.parentAgentId} ${update.subagent.id}`;
        if (update.subagent.status === "running") subagentes.set(clave, update.subagent.parentAgentId);
        else subagentes.delete(clave);
      } else if (update.kind === "remove") subagentes.delete(`${update.parentAgentId} ${update.subagentId}`);
      else return;
      muestraSubagentes();
    },
    error: falla,
  });

  const suscribe = (aviso: () => void) => {
    avisos.add(aviso);
    return () => void avisos.delete(aviso);
  };
  const lee = () => foto;
  const pliega = (plegado: Plegado) => {
    publica({ plegado });
    almacen?.setItem(CLAVE_PLEGADO, JSON.stringify(plegado));
  };

  // The side the block shows on. The Explorer panel exists only while it is "derecha"; whatever part of the plugin is mounted
  // follows a change of the setting, and the server's answer places it at load, before anything mounts.
  let quitaPanel: (() => void) | null = null;
  const colocaPanel = (lado: Lado) => {
    if (lado === "derecha" && !quitaPanel) {
      quitaPanel = client.addWorkspacePanel({
        id: "agentes",
        title: "Agentes",
        icon: "Bot",
        context: "workspace",
        locations: ["explorer"],
        Component: PanelAgentes,
      });
    } else if (lado === "izquierda" && quitaPanel) {
      quitaPanel();
      quitaPanel = null;
    }
  };
  void client.rpc(ladoGet, {}).then(({ lado }) => colocaPanel(lado), falla);
  const useLado = () => {
    const ajustes = useSettings(ajustesAgentes);
    const lado = ajustes.status === "ready" ? ajustes.values.lado : null;
    useEffect(() => {
      if (lado) colocaPanel(lado);
    }, [lado]);
    return { ajustes, lado };
  };

  function AgentesItem({ theme, host, openScreen }: PluginSidebarItemProps) {
    const { lado } = useLado();
    if (lado === "derecha") return null;
    const abre = (agentId: string) => openScreen({ screenId: "abrir", params: { agentId } });
    return <Bloque theme={theme} host={host} abre={abre} enPanel={false} />;
  }

  // Panels get navigation, so a row opens its agent directly.
  function PanelAgentes({ theme, host, navigation }: PluginWorkspacePanelProps) {
    useLado();
    return <Bloque theme={theme} host={host} abre={(agentId) => navigation?.openAgent({ agentId })} enPanel />;
  }

  function AjustesAgentes({ theme }: PluginSurfaceProps) {
    const { ajustes, lado } = useLado();
    if (ajustes.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>Cargando…</Text>;
    if (ajustes.status === "error") return <Text style={{ color: theme.colors.statusDanger }}>No se pudieron leer los ajustes</Text>;
    const { revision } = ajustes;
    return (
      <SettingsSection title="Agentes por estado">
        <SettingsCard>
          <SettingsSelect
            label="Dónde se ve"
            hint="A la izquierda, en la cabecera de la barra lateral; a la derecha, como panel del Explorer, junto a Archivos y Cambios"
            value={lado ?? "izquierda"}
            options={LADOS}
            disabled={ajustes.saving}
            onValueChange={(valor) => void ajustes.save({ lado: valor as Lado }, revision)}
          />
        </SettingsCard>
        {ajustes.saveError ? <Text style={{ color: theme.colors.statusDanger }}>El host no aceptó el cambio</Text> : null}
      </SettingsSection>
    );
  }

  function Bloque({ theme, host, abre, enPanel }: Pick<PluginHostProps, "theme" | "host"> & { abre(agentId: string): void; enPanel: boolean }) {
    const { agentes, subagentes, vigilantes, proyectos, plegado, error } = useSyncExternalStore(suscribe, lee);
    const iconos = useMemo(() => insignias(host.id, proyectos), [host.id, proyectos]);
    const { height } = useWindowDimensions();
    const todos = useMemo(() => agrupar(agentes, subagentes), [agentes, subagentes]);
    const enMarcha = useMemo(() => enMarchaPorFila(agentes, subagentes, vigilantes), [agentes, subagentes, vigilantes]);
    // The filter is per project, after grouping so it hides rows and never a parent its children depend on; an agent whose
    // project is unknown is never hidden by it.
    const grupos = useMemo(
      () =>
        todos
          .map((grupo) => ({ ...grupo, agentes: grupo.agentes.filter((agente) => !agente.projectId || !plegado.ocultos.includes(agente.projectId)) }))
          .filter((grupo) => grupo.agentes.length > 0),
      [todos, plegado.ocultos],
    );
    // One chip per project with rows, most crowded first: its badge toggles the project in and out.
    const fichas = useMemo(() => {
      const conteo = new Map<string, number>();
      for (const { agentes: filas } of todos) {
        for (const { projectId } of filas) if (projectId) conteo.set(projectId, (conteo.get(projectId) ?? 0) + 1);
      }
      return [...conteo].sort(([, a], [, b]) => b - a);
    }, [todos]);
    if (!error && todos.length === 0) {
      return enPanel ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, padding: 16 }}>Ningún agente.</Text> : null;
    }
    const tenue = theme.colors.foregroundMuted;
    const texto = { color: tenue, fontSize: 11 };
    // Left edge of the rows' icons: the row's padding plus its button's.
    const sangria = { paddingLeft: 16, paddingTop: 6, paddingBottom: 2 };
    const linea = { ...sangria, flexDirection: "row", alignItems: "center", gap: 4 } as const;
    const Pliegue = plegado.bloque ? CERRADO : ABIERTO;
    return (
      <View style={enPanel ? { flex: 1, paddingTop: 8 } : undefined}>
        {enPanel ? null : <SidebarSeparator />}
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
          <ScrollView style={enPanel ? { flex: 1 } : { maxHeight: Math.round(height * 0.6) }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingLeft: 16, paddingTop: 4, paddingBottom: 4 }}>
              {fichas.map(([projectId, numero]) => {
                const insignia = iconos.get(projectId);
                const oculto = plegado.ocultos.includes(projectId);
                const nombre = proyectos.find((proyecto) => proyecto.projectId === projectId);
                const Ficha = insignia ? dibujo(insignia) : ICONO_SIN_PROYECTO;
                return (
                  <Pressable
                    key={projectId}
                    accessibilityRole="button"
                    accessibilityLabel={nombre?.projectCustomName ?? nombre?.projectDisplayName ?? projectId}
                    accessibilityState={{ selected: !oculto }}
                    onPress={() =>
                      pliega({ ...plegado, ocultos: oculto ? plegado.ocultos.filter((otro) => otro !== projectId) : [...plegado.ocultos, projectId] })
                    }
                    style={{ flexDirection: "row", alignItems: "center", gap: 3, opacity: oculto ? 0.35 : 1 }}
                  >
                    <Ficha size={14} color={tenue} />
                    <Text style={texto}>{numero}</Text>
                  </Pressable>
                );
              })}
            </View>
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
                        const fila = {
                          icon: insignia ? dibujo(insignia) : ICONOS[grupo],
                          label: agente.title ?? "Sin título",
                          onPress: () => abre(agente.id),
                          trailing: <Marcas enMarcha={enMarcha.get(agente.id)} color={tenue} />,
                        };
                        return enPanel ? (
                          <FilaPanel key={agente.id} {...fila} color={theme.colors.foreground} />
                        ) : (
                          <SidebarRow key={agente.id} id={agente.id} {...fila} />
                        );
                      })
                    : null}
                </Fragment>
              );
            })}
          </ScrollView>
        )}
      </View>
    );
  }

  client.addScreen({ id: "abrir", title: "Agente", Component: AbrirAgente });
  client.addSidebarHeaderItem({ id: "agentes", title: "Agentes", Component: AgentesItem });
  client.addSettingsScreen({ id: "ajustes", title: "Agentes por estado", icon: "Settings", Component: AjustesAgentes });
  return () => {
    lifetime.abort();
    sueltaProyectos();
    quitaPanel?.();
  };
}

const LADOS = [
  { label: "Izquierda: barra lateral", value: "izquierda" },
  { label: "Derecha: panel del Explorer", value: "derecha" },
];

// SidebarRow only renders inside a sidebar item; in the Explorer panel a row is drawn here, with the same parts.
function FilaPanel({ icon: Icono, label, onPress, trailing, color }: { icon: Dibujo; label: string; onPress(): void; trailing: React.ReactNode; color: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 6, opacity: pressed ? 0.6 : 1 })}
    >
      <Icono size={14} color={color} />
      <Text style={{ flex: 1, color, fontSize: 13 }} numberOfLines={2}>
        {label}
      </Text>
      {trailing}
    </Pressable>
  );
}

// What a row runs in the background, beside its title: subagents (Bot) and watchers (Eye), each with its count.
function Marcas({ enMarcha, color }: { enMarcha: EnMarcha | undefined; color: string }) {
  if (!enMarcha) return null;
  const { subagentes, vigilantes } = enMarcha;
  const marca = (icono: string, numero: number) =>
    numero > 0 ? (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
        <Icon name={icono} size={12} color={color} />
        <Text style={{ color, fontSize: 11 }}>{numero}</Text>
      </View>
    ) : null;
  return (
    <View
      accessible
      accessibilityLabel={`${subagentes} subagentes y ${vigilantes} watchers en marcha`}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8 }}
    >
      {marca("Bot", subagentes)}
      {marca("Eye", vigilantes)}
    </View>
  );
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
