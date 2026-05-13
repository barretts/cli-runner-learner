/**
 * Concurrency pool for parallel task execution.
 * Ported from 3pp-fix-database/src/orchestrator.ts runPool().
 */
export declare function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void>;
export declare const FIBONACCI_BATCH_SIZES: readonly [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
export declare function nextFibonacciBatchSize(current: number): number;
export declare function prevFibonacciBatchSize(current: number): number;
