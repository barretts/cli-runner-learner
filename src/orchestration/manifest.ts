/**
 * Manifest loading and validation.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { Manifest, TaskDef } from "./types.js";

export async function loadManifest(path: string): Promise<Manifest> {
  const raw = await readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse manifest: ${(e as Error).message}`);
  }

  const manifest = parsed as Manifest;
  if (manifest.version !== "1.0") {
    throw new Error(`Unsupported manifest version: ${manifest.version}`);
  }

  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
    throw new Error("Manifest must contain at least one task");
  }

  // Resolve input_ref paths relative to manifest location
  const baseDir = dirname(resolve(path));
  for (const task of manifest.tasks) {
    if (task.input_ref && !task.input) {
      const refPath = resolve(baseDir, task.input_ref);
      task.input = await readFile(refPath, "utf-8");
    }
  }

  // Resolve shared_context_ref
  if (manifest.shared_context_ref && !manifest.shared_context) {
    const refPath = resolve(baseDir, manifest.shared_context_ref);
    manifest.shared_context = await readFile(refPath, "utf-8");
  }

  validateManifest(manifest);
  return manifest;
}

export function validateManifest(manifest: Manifest): void {
  const ids = new Set<string>();
  for (const task of manifest.tasks) {
    if (!task.id) throw new Error("Task missing required field: id");
    if (!task.tool_id) throw new Error(`Task "${task.id}" missing required field: tool_id`);
    if (!task.input && !task.input_ref) {
      throw new Error(`Task "${task.id}" must have input or input_ref`);
    }
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);

    if (!task.depends_on) task.depends_on = [];
    if (!task.timeout_sec) task.timeout_sec = 300;
  }

  // Validate depends_on references
  for (const task of manifest.tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) {
        throw new Error(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
  }

  // Cycle detection via topological sort
  detectCycles(manifest.tasks);

  // Validate verify profile references
  if (manifest.verify_profiles) {
    for (const task of manifest.tasks) {
      if (task.verify && !(task.verify in manifest.verify_profiles)) {
        throw new Error(`Task "${task.id}" references unknown verify profile "${task.verify}"`);
      }
    }
  }
}

function detectCycles(tasks: TaskDef[]): void {
  const graph = new Map<string, string[]>();
  for (const task of tasks) {
    graph.set(task.id, task.depends_on);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string): void {
    if (inStack.has(id)) {
      throw new Error(`Dependency cycle detected involving task "${id}"`);
    }
    if (visited.has(id)) return;

    inStack.add(id);
    for (const dep of graph.get(id) ?? []) {
      dfs(dep);
    }
    inStack.delete(id);
    visited.add(id);
  }

  for (const task of tasks) {
    dfs(task.id);
  }
}

/**
 * Topological sort: returns tasks in dependency order.
 */
export function topoSort(tasks: TaskDef[]): TaskDef[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const result: TaskDef[] = [];

  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const task = taskMap.get(id)!;
    for (const dep of task.depends_on) {
      visit(dep);
    }
    result.push(task);
  }

  // Sort by priority first, then topo order
  const sorted = [...tasks].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  for (const task of sorted) {
    visit(task.id);
  }

  return result;
}
