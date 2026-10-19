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
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Animated, Easing, Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import {
  agrupar,
  enMarchaPorFila,
  hace,
  insignias,
  leePlegado,
  porProyecto,
  type Agente,
  type EnMarcha,
  type Grupo,
  type Insignia,
  type Plegado,
  type Proyecto,
  type Workspace,
} from "../shared/agentes.ts";
import { ajustesAgentes, type Agrupar, type Lado } from "../shared/ajustes.ts";
import { vigilantesList } from "../shared/contract.ts";

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
// The header's quick switch: the icon shows the grouping you get when you press it.
const ICONO_GRUPOS = icono("Layers");
const ICONO_ESTADO = icono("List");
// Fold everything under a header at once.
const TODO_CERRADO = icono("ChevronsDownUp");
const TODO_ABIERTO = icono("ChevronsUpDown");

// The two arrows that fold or unfold everything under a header; `label` names what they act on.
function BotonesPlegar({ label, color, onPlegar, onDesplegar }: { label: string; color: string; onPlegar(): void; onDesplegar(): void }) {
  return (
    <View style={{ flexDirection: "row", gap: 6, marginLeft: 6 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Plegar ${label}`} hitSlop={6} onPress={onPlegar}>
        <TODO_CERRADO size={11} color={color} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`Desplegar ${label}`} hitSlop={6} onPress={onDesplegar}>
        <TODO_ABIERTO size={11} color={color} />
      </Pressable>
    </View>
  );
}
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
  /** The daemon's workspace directory, by id: name, status and its time, for the workspace grouping. */
  readonly workspaces: ReadonlyMap<string, Workspace>;
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
  let foto: Foto = { agentes: [], subagentes: new Map(), vigilantes: {}, workspaces: new Map(), proyectos: [], plegado: leePlegado(almacen?.getItem(CLAVE_PLEGADO) ?? null), error: null };
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

  // When each agent stopped talking: Paseo's attention timestamp while the notice stands, plus the running→idle moment
  // caught here, which survives opening the agent (Paseo clears the notice as soon as you see it).
  // shortcut: on load an agent already read has no time to show — the daemon keeps none; upgrade when the protocol carries one.
  const terminos = new Map<string, string>();
  const estados = new Map<string, string>();
  const apunta = (agente: Agente) => {
    if (agente.attentionTimestamp) terminos.set(agente.id, agente.attentionTimestamp);
    if (estados.get(agente.id) === "running" && agente.status !== "running") terminos.set(agente.id, new Date().toISOString());
    estados.set(agente.id, agente.status);
  };

  // Watchers have no event: they start inside a turn and their end wakes the agent, so a change of agents is when to look again.
  // At most one read every 3 s (the host scan, /proc or lsof, costs ~150 ms to ~1 s and runs async).
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
          for (const { agent, project } of entries) {
            filas.set(agent.id, { ...agent, projectId: project.projectKey });
            apunta(agent);
          }
          muestraFilas();
          leeVigilantes();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            filas.delete(update.agentId);
            terminos.delete(update.agentId);
            estados.delete(update.agentId);
          } else {
            const projectId = update.project?.projectKey ?? filas.get(update.agent.id)?.projectId ?? null;
            filas.set(update.agent.id, { ...update.agent, projectId });
            apunta(update.agent);
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

  // The daemon's workspace directory — the same one that feeds Paseo's sidebar, with its own status and time per workspace.
  // shortcut: first page only, like the agents list; a host with more workspaces than one page holds is not this block's case.
  const trabajos = new Map<string, Workspace>();
  const recorta = (w: { id: string; name: string; projectId: string; status: Workspace["status"]; statusEnteredAt: string | null }): Workspace => ({
    id: w.id,
    name: w.name,
    projectId: w.projectId,
    status: w.status,
    statusEnteredAt: w.statusEnteredAt,
  });
  let sueltaTrabajos: (() => void) | null = null;
  let suscripcionTrabajos: { release(): Promise<void> } | null = null;
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (lifetime.signal.aborted) return void subscription.release();
      suscripcionTrabajos = subscription;
      sueltaTrabajos = subscription.subscribe({
        snapshot: ({ entries }) => {
          trabajos.clear();
          for (const w of entries) trabajos.set(w.id, recorta(w));
          publica({ workspaces: new Map(trabajos) });
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const cambio = message.payload;
          if (cambio.kind === "upsert") trabajos.set(cambio.workspace.id, recorta(cambio.workspace));
          else trabajos.delete(cambio.id);
          publica({ workspaces: new Map(trabajos) });
        },
      });
    })
    .catch(falla);

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

  // The setting only decides whether the sidebar shows the block. The Explorer panel stays registered on either side: a panel
  // removed while its tab is open leaves a dead «This plugin panel is unavailable» tab behind.
  function AgentesItem({ theme, host, openScreen }: PluginSidebarItemProps) {
    const ajustes = useSettings(ajustesAgentes);
    if (ajustes.status === "ready" && ajustes.values.lado === "derecha") return null;
    const abre = (agentId: string) => openScreen({ screenId: "abrir", params: { agentId } });
    return <Bloque theme={theme} host={host} abre={abre} enPanel={false} />;
  }

  // Panels get navigation, so a row opens its agent directly.
  function PanelAgentes({ theme, host, navigation }: PluginWorkspacePanelProps) {
    return <Bloque theme={theme} host={host} abre={(agentId) => navigation?.openAgent({ agentId })} enPanel />;
  }

  function AjustesAgentes({ theme }: PluginSurfaceProps) {
    const ajustes = useSettings(ajustesAgentes);
    if (ajustes.status === "loading") return <Text style={{ color: theme.colors.foregroundMuted }}>Cargando…</Text>;
    if (ajustes.status === "error") return <Text style={{ color: theme.colors.statusDanger }}>No se pudieron leer los ajustes</Text>;
    const { revision } = ajustes;
    // `save` replaces the whole document: merge with what is on screen so changing one select keeps the other.
    const valores = ajustes.status === "ready" ? ajustes.values : { lado: "izquierda" as Lado, agrupar: "estado" as Agrupar };
    return (
      <SettingsSection title="Agentes por estado">
        <SettingsCard>
          <SettingsSelect
            label="Dónde se ve"
            hint="A la derecha, el bloque sale de la barra lateral: ábrelo como panel «Agentes» con el + del Explorer, junto a Archivos y Cambios"
            value={ajustes.status === "ready" ? ajustes.values.lado : "izquierda"}
            options={LADOS}
            disabled={ajustes.saving}
            onValueChange={(valor) => void ajustes.save({ ...valores, lado: valor as Lado }, revision)}
          />
          <SettingsSelect
            label="Cómo se agrupa"
            hint="Cuatro niveles: proyecto, workspace (con su estado y su hora), grupo de estado y agentes, como la barra lateral de Paseo"
            value={ajustes.status === "ready" ? ajustes.values.agrupar : "estado"}
            options={AGRUPACIONES}
            disabled={ajustes.saving}
            onValueChange={(valor) => void ajustes.save({ ...valores, agrupar: valor as Agrupar }, revision)}
          />
        </SettingsCard>
        {ajustes.saveError ? <Text style={{ color: theme.colors.statusDanger }}>El host no aceptó el cambio</Text> : null}
      </SettingsSection>
    );
  }

  function Bloque({ theme, host, abre, enPanel }: Pick<PluginHostProps, "theme" | "host"> & { abre(agentId: string): void; enPanel: boolean }) {
    const { agentes, subagentes, vigilantes, workspaces, proyectos, plegado, error } = useSyncExternalStore(suscribe, lee);
    const ajustes = useSettings(ajustesAgentes);
    const modo: Agrupar = ajustes.status === "ready" ? ajustes.values.agrupar : "estado";
    const iconos = useMemo(() => insignias(host.id, proyectos), [host.id, proyectos]);
    const { height } = useWindowDimensions();
    const todos = useMemo(() => agrupar(agentes, subagentes), [agentes, subagentes]);
    const enMarcha = useMemo(() => enMarchaPorFila(agentes, subagentes, vigilantes), [agentes, subagentes, vigilantes]);
    // A relative time goes stale while nothing else moves: wake the block once a minute.
    const [, despierta] = useState(0);
    useEffect(() => {
      const id = setInterval(() => despierta((numero) => numero + 1), 60_000);
      return () => void clearInterval(id);
    }, []);
    // The filter is per project, after grouping so it hides rows and never a parent its children depend on; an agent whose
    // project is unknown is never hidden by it.
    const visibles = (filas: readonly Fila[]) => filas.filter((agente) => !agente.projectId || !plegado.ocultos.includes(agente.projectId));
    // The group filter (the header's counters) applies after grouping, like the project one, so no parent is hidden under a child it needs.
    const filtrar = <T extends { grupo: Grupo }>(grupos: readonly T[]) =>
      plegado.filtro.length === 0 ? grupos : grupos.filter((grupo) => plegado.filtro.includes(grupo.grupo));
    const gruposVisibles = useMemo(
      () => todos.map((grupo) => ({ ...grupo, agentes: visibles(grupo.agentes) })).filter((grupo) => grupo.agentes.length > 0),
      [todos, plegado.ocultos],
    );
    const grupos = useMemo(() => filtrar(gruposVisibles), [gruposVisibles, plegado.filtro]);
    const porProy = useMemo(
      () =>
        porProyecto(agentes, subagentes, workspaces, proyectos)
          .map((proyecto) => ({
            ...proyecto,
            workspaces: proyecto.workspaces
              .map((bloque) => ({ ...bloque, grupos: filtrar(bloque.grupos.map((grupo) => ({ ...grupo, agentes: visibles(grupo.agentes) })).filter((grupo) => grupo.agentes.length > 0)) }))
              .filter((bloque) => bloque.grupos.length > 0),
          }))
          .filter((proyecto) => proyecto.workspaces.length > 0),
      [agentes, subagentes, workspaces, proyectos, plegado.ocultos, plegado.filtro],
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
    const Cambio = modo === "estado" ? ICONO_GRUPOS : ICONO_ESTADO;
    // «Plegar/desplegar todas»: the ids of the headers that exist now. Group folding stays global, as a group header's own fold is.
    const idsWs = [...new Set(porProy.flatMap(({ workspaces }) => workspaces.map(({ workspace }) => workspace?.id ?? "")))];
    const idsProy = [...new Set(porProy.map(({ proyecto }) => proyecto?.projectId ?? ""))];
    const gruposVistos = [...new Set(todos.map(({ grupo }) => grupo))];
    const pliegaTodo = (cerrar: boolean) =>
      pliega({ ...plegado, grupos: cerrar ? gruposVistos : [], workspaces: cerrar ? idsWs : [], proyectos: cerrar ? idsProy : [] });
    // One status group with its rows, shared by the two groupings; `sangria` is where the workspace mode indents it under its header.
    const dibujaGrupo = ({ grupo, titulo, agentes: filas }: (typeof grupos)[number], sangria: number) => {
      const abierto = !plegado.grupos.includes(grupo);
      const Flecha = abierto ? ABIERTO : CERRADO;
      return (
        <Fragment key={`${sangria}${grupo}`}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: abierto }}
            onPress={() =>
              pliega({ ...plegado, grupos: abierto ? [...plegado.grupos, grupo] : plegado.grupos.filter((otro) => otro !== grupo) })
            }
            style={[linea, sangria ? { paddingLeft: sangria } : undefined]}
          >
            <Flecha size={12} color={tenue} />
            <Text style={texto}>{`${titulo} · ${filas.length}`}</Text>
          </Pressable>
          {abierto
            ? filas.map((agente) => {
                const insignia = agente.projectId ? iconos.get(agente.projectId) : undefined;
                // The time at the line's end: Paseo's row shows it for a running agent too, since its turn began; the rest, since it stopped talking.
                const desde = grupo === "enEjecucion" ? agente.activeTurn?.startedAt ?? agente.updatedAt ?? terminos.get(agente.id) : terminos.get(agente.id);
                const tiempo = hace(desde, Date.now());
                const fila = {
                  icon: modo === "workspace" ? puntoDe(grupo, theme) : insignia ? dibujo(insignia) : ICONOS[grupo],
                  label: agente.title ?? "Sin título",
                  onPress: () => abre(agente.id),
                  trailing: (
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <Marcas enMarcha={enMarcha.get(agente.id)} color={tenue} />
                      {tiempo ? <Text style={{ ...texto, paddingRight: 8 }}>{tiempo}</Text> : null}
                    </View>
                  ),
                };
                return enPanel ? (
                  <FilaPanel key={agente.id} {...fila} color={theme.colors.foreground} />
                ) : (
                  <View key={agente.id} style={sangria ? { paddingLeft: sangria } : undefined}>
                    <SidebarRow id={agente.id} {...fila} />
                  </View>
                );
              })
            : null}
        </Fragment>
      );
    };
    // One workspace with its groups under it; `sangria` is where the project mode indents it under the project header.
    const dibujaWorkspace = (bloque: (typeof porProy)[number]["workspaces"][number], sangria: number) => {
      const { workspace, grupos: delWorkspace } = bloque;
      const id = workspace?.id ?? "";
      const cerrado = plegado.workspaces.includes(id);
      const Flecha = cerrado ? CERRADO : ABIERTO;
      const total = delWorkspace.reduce((numero, grupo) => numero + grupo.agentes.length, 0);
      const tiempo = workspace ? hace(workspace.statusEnteredAt, Date.now()) : null;
      return (
        <Fragment key={id || "sin-workspace"}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: !cerrado }}
            onPress={() =>
              pliega({ ...plegado, workspaces: cerrado ? plegado.workspaces.filter((otro) => otro !== id) : [...plegado.workspaces, id] })
            }
            style={[linea, { paddingLeft: sangria, paddingRight: 16 }]}
          >
            <Flecha size={12} color={tenue} />
            <PuntoEstado grupo={GRUPO_DE[workspace?.status ?? "done"]} theme={theme} />
            <Text style={[texto, { flex: 1 }]} numberOfLines={1}>
              {workspace?.name ?? "Sin workspace"}
            </Text>
            <Text style={texto}>{total}</Text>
            {tiempo ? <Text style={[texto, { paddingLeft: 6 }]}>{tiempo}</Text> : null}
            <BotonesPlegar
              label={`los grupos de ${workspace?.name ?? "este workspace"}`}
              color={tenue}
              onPlegar={() => pliega({ ...plegado, grupos: [...new Set([...plegado.grupos, ...delWorkspace.map(({ grupo }) => grupo)])] })}
              onDesplegar={() => {
                const propios = new Set(delWorkspace.map(({ grupo }) => grupo));
                pliega({ ...plegado, grupos: plegado.grupos.filter((otro) => !propios.has(otro)) });
              }}
            />
          </Pressable>
          {cerrado ? null : delWorkspace.map((grupo) => dibujaGrupo(grupo, sangria + 12))}
        </Fragment>
      );
    };
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
          {gruposVisibles.map(({ grupo, titulo, agentes }) => {
            const Simbolo = ICONOS[grupo];
            const activo = plegado.filtro.includes(grupo);
            return (
              <Pressable
                key={grupo}
                accessibilityRole="button"
                accessibilityLabel={`Filtrar por ${titulo}`}
                accessibilityState={{ selected: activo }}
                hitSlop={6}
                onPress={() =>
                  pliega({ ...plegado, filtro: activo ? plegado.filtro.filter((otro) => otro !== grupo) : [...plegado.filtro, grupo] })
                }
                style={{ flexDirection: "row", alignItems: "center", gap: 2, marginLeft: 6, opacity: activo || plegado.filtro.length === 0 ? 1 : 0.35 }}
              >
                <Simbolo size={12} color={tenue} />
                <Text style={texto}>{agentes.length}</Text>
              </Pressable>
            );
          })}
          <BotonesPlegar label="todo" color={tenue} onPlegar={() => pliegaTodo(true)} onDesplegar={() => pliegaTodo(false)} />
          {ajustes.status === "ready" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={modo === "estado" ? "Agrupar por proyecto" : "Agrupar por estado"}
              hitSlop={6}
              onPress={() => void ajustes.save({ ...ajustes.values, agrupar: modo === "estado" ? "workspace" : "estado" }, ajustes.revision)}
              style={{ marginLeft: 8 }}
            >
              <Cambio size={12} color={tenue} />
            </Pressable>
          ) : null}
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
            {modo === "workspace"
              ? porProy.map(({ proyecto, workspaces: wss }) => {
                  const id = proyecto?.projectId ?? "";
                  const cerrado = plegado.proyectos.includes(id);
                  const Flecha = cerrado ? CERRADO : ABIERTO;
                  const total = wss.reduce((numero, bloque) => numero + bloque.grupos.reduce((n, g) => n + g.agentes.length, 0), 0);
                  const insignia = proyecto ? iconos.get(proyecto.projectId) : undefined;
                  const Icono = insignia ? dibujo(insignia) : ICONO_SIN_PROYECTO;
                  return (
                    <Fragment key={id || "sin-proyecto"}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ expanded: !cerrado }}
                        onPress={() =>
                          pliega({ ...plegado, proyectos: cerrado ? plegado.proyectos.filter((otro) => otro !== id) : [...plegado.proyectos, id] })
                        }
                        style={[linea, { paddingRight: 16 }]}
                      >
                        <Flecha size={12} color={tenue} />
                        <Icono size={14} color={tenue} />
                        <Text style={[texto, { flex: 1 }]} numberOfLines={1}>
                          {proyecto?.projectCustomName ?? proyecto?.projectDisplayName ?? "Sin proyecto"}
                        </Text>
                        <Text style={texto}>{total}</Text>
                        <BotonesPlegar
                          label={`los workspaces de ${proyecto?.projectCustomName ?? proyecto?.projectDisplayName ?? "este proyecto"}`}
                          color={tenue}
                          onPlegar={() =>
                            pliega({ ...plegado, workspaces: [...new Set([...plegado.workspaces, ...wss.map(({ workspace }) => workspace?.id ?? "")])] })
                          }
                          onDesplegar={() => {
                            const propios = new Set(wss.map(({ workspace }) => workspace?.id ?? ""));
                            pliega({ ...plegado, workspaces: plegado.workspaces.filter((otro) => !propios.has(otro)) });
                          }}
                        />
                      </Pressable>
                      {cerrado ? null : wss.map((bloque) => dibujaWorkspace(bloque, 28))}
                    </Fragment>
                  );
                })
              : grupos.map((grupo) => dibujaGrupo(grupo, 0))}
          </ScrollView>
        )}
      </View>
    );
  }

  client.addScreen({ id: "abrir", title: "Agente", Component: AbrirAgente });
  client.addSidebarHeaderItem({ id: "agentes", title: "Agentes", Component: AgentesItem });
  client.addWorkspacePanel({ id: "agentes", title: "Agentes", icon: "Bot", context: "workspace", locations: ["explorer"], Component: PanelAgentes });
  client.addSettingsScreen({ id: "ajustes", title: "Ajustes", icon: "Settings", Component: AjustesAgentes });
  return () => {
    lifetime.abort();
    sueltaProyectos();
    sueltaTrabajos?.();
    void suscripcionTrabajos?.release();
  };
}

const LADOS = [
  { label: "Izquierda: barra lateral", value: "izquierda" },
  { label: "Derecha: panel del Explorer", value: "derecha" },
];

const AGRUPACIONES = [
  { label: "Por estado: necesita datos, en ejecución…", value: "estado" },
  { label: "Proyecto → workspace → estado → agentes", value: "workspace" },
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

// The daemon's workspace status (WorkspaceDescriptorPayload) read as one of the block's groups: the same five states by Paseo's name.
const GRUPO_DE: Record<Workspace["status"], Grupo> = {
  needs_input: "necesitaDatos",
  failed: "conError",
  running: "enEjecucion",
  attention: "paraRevisar",
  done: "terminado",
};

// Paseo's statusDot band (app styles/theme.ts) is not in the plugin theme: the pair is picked by the surface's luminance.
const PARES: Record<Grupo, readonly [claro: string, oscuro: string]> = {
  necesitaDatos: ["#b37824", "#db932e"],
  conError: ["#f12e2f", "#f7796d"],
  enEjecucion: ["#268ae0", "#5caaf6"],
  paraRevisar: ["#299f51", "#35c264"],
  terminado: ["#000000", "#ffffff"], // unused: the muted dot takes its color from the theme
};

function esOscuro(fondo: string): boolean {
  const hex = fondo.replace("#", "");
  if (hex.length < 6) return true;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.5;
}

function colorDe(grupo: Grupo, theme: PluginHostProps["theme"]): string {
  if (grupo === "terminado") return theme.colors.foregroundMuted;
  const [claro, oscuro] = PARES[grupo];
  return esOscuro(theme.colors.surface0) ? oscuro : claro;
}

// Paseo's StatusRing (app components/status-ring), copied to its numbers: a 6-dot centre with a 1.5 gap and a 1.5-stroke
// ring around it, one 900 ms turn. Plain RN Animated instead of Reanimated: a plugin cannot import the app's clock.
function AnilloEstado({ color }: { color: string }) {
  const giro = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animacion = Animated.loop(
      Animated.timing(giro, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: Platform.OS !== "web" }),
    );
    animacion.start();
    return () => animacion.stop();
  }, [giro]);
  const rotar = giro.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
      <View style={{ position: "absolute", width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: color, opacity: 0.3 }} />
      <Animated.View style={{ position: "absolute", width: 12, height: 12, transform: [{ rotate: rotar }] }}>
        <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: "transparent", borderTopColor: color, opacity: 0.9 }} />
      </Animated.View>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
    </View>
  );
}

// Paseo's WorkspaceStatusIndicator (app sidebar-workspace-row-content.tsx): one slot where running is the ring,
// needs_input the amber alert, attention a filled dot, and done a muted dot that only holds the rail.
function PuntoEstado({ grupo, theme }: { grupo: Grupo; theme: PluginHostProps["theme"] }) {
  const color = colorDe(grupo, theme);
  const caja = { width: 14, height: 16, alignItems: "center", justifyContent: "center", flexShrink: 0 } as const;
  if (grupo === "enEjecucion") {
    return (
      <View style={caja}>
        <AnilloEstado color={color} />
      </View>
    );
  }
  if (grupo === "necesitaDatos") {
    return (
      <View style={caja}>
        <Icon name="CircleAlert" size={12} color={color} />
      </View>
    );
  }
  return (
    <View style={caja}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color, opacity: grupo === "terminado" ? 0.3 : 1 }} />
    </View>
  );
}

// A row's icon has to be a component: one per group and color, so a row keeps its element across renders.
const puntos = new Map<string, Dibujo>();
function puntoDe(grupo: Grupo, theme: PluginHostProps["theme"]): Dibujo {
  const color = colorDe(grupo, theme);
  const clave = `${grupo}${color}`;
  let dibujado = puntos.get(clave);
  if (!dibujado) {
    dibujado = () => <PuntoEstado grupo={grupo} theme={theme} />;
    puntos.set(clave, dibujado);
  }
  return dibujado;
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
