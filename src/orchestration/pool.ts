/**
 * Concurrency pool for parallel task execution.
 * Ported from 3pp-fix-database/src/orchestrator.ts runPool().
 */

export async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (concurrency <= 1) {
    for (const item of items) await fn(item);
    return;
  }
  const executing = new Set<Promise<void>>();
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

export const FIBONACCI_BATCH_SIZES = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89] as const;

export function nextFibonacciBatchSize(current: number): number {
  const idx = FIBONACCI_BATCH_SIZES.indexOf(current as typeof FIBONACCI_BATCH_SIZES[number]);
  if (idx === -1 || idx >= FIBONACCI_BATCH_SIZES.length - 1) return current;
  return FIBONACCI_BATCH_SIZES[idx + 1];
}

export function prevFibonacciBatchSize(current: number): number {
  const idx = FIBONACCI_BATCH_SIZES.indexOf(current as typeof FIBONACCI_BATCH_SIZES[number]);
  if (idx <= 0) return FIBONACCI_BATCH_SIZES[0];
  return FIBONACCI_BATCH_SIZES[idx - 1];
}
