/**
 * Manifest loading and validation.
 */
import type { Manifest, TaskDef } from "./types.js";
export declare function loadManifest(path: string): Promise<Manifest>;
export declare function validateManifest(manifest: Manifest): void;
/**
 * Topological sort: returns tasks in dependency order.
 */
export declare function topoSort(tasks: TaskDef[]): TaskDef[];
