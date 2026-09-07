/**
 * Tiny TTL cache used to avoid hammering upstream sources.
 */
class TTLCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async getOrSet(key, ttlMs, producer) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await producer();
    this.set(key, value, ttlMs);
    return value;
  }

  /**
   * Stale-while-revalidate style read: returns cached value immediately if
   * present (even if expired) and refreshes it in the background.
   */
  async swr(key, ttlMs, producer) {
    const entry = this.store.get(key);
    const fresh = entry && Date.now() <= entry.expiresAt;
    if (fresh) return entry.value;

    if (entry) {
      // stale: refresh in background, serve old value
      producer()
        .then((v) => this.set(key, v, ttlMs))
        .catch(() => {});
      return entry.value;
    }

    // nothing cached: await producer, fall back to last-good on failure
    try {
      const v = await producer();
      this.set(key, v, ttlMs);
      return v;
    } catch (err) {
      if (entry) return entry.value;
      throw err;
    }
  }

  stats() {
    return { keys: this.store.size };
  }
}

module.exports = { TTLCache };
