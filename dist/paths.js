/**
 * Path resolution for cli-runner-learner data directories.
 *
 * Problem: When installed into node_modules/, writing to the package root pollutes
 * the install tree and breaks under read-only installs (global npm, npx cache, Nix,
 * Docker). We use a data directory convention instead.
 *
 * Resolution order:
 * - CLI flag: --data-dir <path>
 * - Env var: CLR_DATA_DIR
 * - Default: process.cwd()/.clr/
 *
 * Profile resolution order (read):
 * - <dataDir>/profiles/<id>.json (user's learned profiles)
 * - <packageRoot>/profiles/<id>.json (bundled seed profiles from npm)
 *
 * Writes always go to <dataDir>/.
 */
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
// Cache the resolved data dir (computed once per process)
let _dataDir = null;
let _packageRoot = null;
/**
 * Get the package root (where the package is installed).
 * This is used to find bundled profiles and other package resources.
 */
export function getPackageRoot() {
    if (_packageRoot)
        return _packageRoot;
    // Derive from this file's location: src/paths.ts -> package root
    _packageRoot = resolve(new URL("../", import.meta.url).pathname);
    return _packageRoot;
}
/**
 * Get the data directory where runtime files are stored.
 * Priority: CLR_DATA_DIR env -> process.cwd()/.clr/
 */
export function getDataDir() {
    if (_dataDir)
        return _dataDir;
    _dataDir = process.env.CLR_DATA_DIR ?? join(process.cwd(), ".clr");
    return _dataDir;
}
/**
 * Get the transcript directory.
 */
export function getTranscriptDir() {
    return join(getDataDir(), "transcripts");
}
/**
 * Get the profiles directory (user's learned profiles).
 */
export function getProfileDir() {
    return join(getDataDir(), "profiles");
}
/**
 * Get the learn state directory.
 */
export function getStateDir() {
    return join(getDataDir(), "state");
}
/**
 * Get the logs directory.
 */
export function getLogsDir() {
    return join(getDataDir(), "logs");
}
/**
 * Get the bundled seed profiles directory (read-only, from npm package).
 */
export function getBundledProfileDir() {
    return join(getPackageRoot(), "profiles");
}
/**
 * Load a profile, searching user dir first then bundled dir.
 * Returns null if not found in either location.
 */
export async function loadProfileFromAnywhere(toolId) {
    // Check user profiles first
    const userProfilePath = join(getProfileDir(), `${toolId}.json`);
    if (existsSync(userProfilePath)) {
        return userProfilePath;
    }
    // Fall back to bundled profiles
    const bundledProfilePath = join(getBundledProfileDir(), `${toolId}.json`);
    if (existsSync(bundledProfilePath)) {
        return bundledProfilePath;
    }
    return null;
}
/**
 * Reset path cache (for testing or when data dir changes).
 */
export function resetPathCache() {
    _dataDir = null;
    _packageRoot = null;
}
//# sourceMappingURL=paths.js.map