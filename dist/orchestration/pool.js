/**
 * Concurrency pool for parallel task execution.
 * Ported from 3pp-fix-database/src/orchestrator.ts runPool().
 */
export async function runPool(items, concurrency, fn) {
    if (concurrency <= 1) {
        for (const item of items)
            await fn(item);
        return;
    }
    const executing = new Set();
    for (const item of items) {
        const p = fn(item).finally(() => executing.delete(p));
        executing.add(p);
        if (executing.size >= concurrency) {
            await Promise.race(executing);
        }
    }
    await Promise.allSettled(executing);
}
// ---- Fibonacci Batch Sizing ----
export const FIBONACCI_BATCH_SIZES = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
export function nextFibonacciBatchSize(current) {
    const idx = FIBONACCI_BATCH_SIZES.indexOf(current);
    if (idx === -1 || idx >= FIBONACCI_BATCH_SIZES.length - 1)
        return current;
    return FIBONACCI_BATCH_SIZES[idx + 1];
}
export function prevFibonacciBatchSize(current) {
    const idx = FIBONACCI_BATCH_SIZES.indexOf(current);
    if (idx <= 0)
        return FIBONACCI_BATCH_SIZES[0];
    return FIBONACCI_BATCH_SIZES[idx - 1];
}
//# sourceMappingURL=pool.js.map