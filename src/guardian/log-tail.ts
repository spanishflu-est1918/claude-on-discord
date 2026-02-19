export function resolveGuardianLogTail(input: {
  tailRaw: string | null;
  maxTail: number;
  fallbackTail?: number;
}): number {
  const fallback = input.fallbackTail ?? 200;
  const tail = input.tailRaw ? Number.parseInt(input.tailRaw, 10) : fallback;
  return Number.isFinite(tail) ? Math.min(Math.max(tail, 10), input.maxTail) : fallback;
}
