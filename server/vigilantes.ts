import { readdirSync, readlinkSync } from "node:fs";

// Claude Code writes each task's output to <tmp>/claude-<uid>/<cwd key>/<session id>/tasks/<task id>.output; the shell running
// it holds the file open until it ends. Paseo keeps no state for background shells, so this is the only place they show.
const TAREA = /\/claude-\d+\/[^/]+\/([0-9a-f-]{36})\/tasks\/([^/]+)\.output$/;

/**
 * Running Claude Code tasks per session id: the task files some live process holds open. Reads only what the daemon's user
 * may read. shortcut: a command the agent runs in the foreground during its turn counts too (same task file); fine while the
 * row already says the turn runs, upgrade if Claude Code marks backgrounded tasks apart.
 */
export function vigilantes(proc = "/proc"): Record<string, number> {
  const sesionDeTarea = new Map<string, string>();
  for (const pid of readdirSync(proc)) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`${proc}/${pid}/fd`);
    } catch {
      continue; // gone meanwhile, or another user's
    }
    for (const fd of fds) {
      let destino: string;
      try {
        destino = readlinkSync(`${proc}/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const tarea = TAREA.exec(destino);
      if (tarea) sesionDeTarea.set(`${tarea[1]}/${tarea[2]}`, tarea[1]!);
    }
  }
  const cuenta: Record<string, number> = {};
  for (const sesion of sesionDeTarea.values()) cuenta[sesion] = (cuenta[sesion] ?? 0) + 1;
  return cuenta;
}
