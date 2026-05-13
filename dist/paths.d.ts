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
/**
 * Get the package root (where the package is installed).
 * This is used to find bundled profiles and other package resources.
 */
export declare function getPackageRoot(): string;
/**
 * Get the data directory where runtime files are stored.
 * Priority: CLR_DATA_DIR env -> process.cwd()/.clr/
 */
export declare function getDataDir(): string;
/**
 * Get the transcript directory.
 */
export declare function getTranscriptDir(): string;
/**
 * Get the profiles directory (user's learned profiles).
 */
export declare function getProfileDir(): string;
/**
 * Get the learn state directory.
 */
export declare function getStateDir(): string;
/**
 * Get the logs directory.
 */
export declare function getLogsDir(): string;
/**
 * Get the bundled seed profiles directory (read-only, from npm package).
 */
export declare function getBundledProfileDir(): string;
/**
 * Load a profile, searching user dir first then bundled dir.
 * Returns null if not found in either location.
 */
export declare function loadProfileFromAnywhere(toolId: string): Promise<string | null>;
/**
 * Reset path cache (for testing or when data dir changes).
 */
export declare function resetPathCache(): void;
