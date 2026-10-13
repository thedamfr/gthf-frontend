/** Admit this process after one real dependency check; retain warm public caches during outages. */
export function createServingReadiness(check: () => Promise<boolean>) {
  let admitted = false;
  let pending: Promise<boolean> | undefined;
  return async () => {
    if (admitted) return true;
    pending ??= check().catch(() => false).then((ready) => { admitted = ready; return ready; });
    try { return await pending; }
    finally { pending = undefined; }
  };
}
