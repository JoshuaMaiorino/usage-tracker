// Keep reading choices across polling, while surfacing newly urgent model limits.
export class DisclosureState {
  #entries = new Map();

  update(id, windows = []) {
    const previous = this.#entries.get(id) || { open: false, levels: new Map() };
    const levels = new Map();
    for (const window of windows) {
      const value = window.usedPercent;
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const key = JSON.stringify([window.id || window.label, window.scope, window.durationSeconds]);
      const level = value >= 100 ? 2 : value >= 90 ? 1 : 0;
      levels.set(key, Math.max(levels.get(key) || 0, level));
    }
    const escalated = [...levels].some(([key, level]) => level > (previous.levels.get(key) || 0));
    const next = { open: previous.open || escalated, levels };
    this.#entries.set(id, next);
    return next.open;
  }

  setOpen(id, open) {
    const entry = this.#entries.get(id) || { levels: new Map() };
    this.#entries.set(id, { ...entry, open: Boolean(open) });
  }
}
