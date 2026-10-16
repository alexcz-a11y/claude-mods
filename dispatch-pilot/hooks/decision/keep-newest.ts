// Keeping the most recent few entries of a Map that is only a reminder (the held-back parts of messages, the messages typed into a
// running turn, the agents and checks of the repeat count). A Map keeps its keys in the order they were first set, so the oldest
// come first; a key set again keeps its place, so delete it first to make it the newest.
// Pure (see system-one.ts).

/** Deletes the oldest entries of `entries` (those set first) until at most `most` are left. */
export function keepNewest(entries: Map<unknown, unknown>, most: number): void {
  for (const oldest of [...entries.keys()].slice(0, Math.max(0, entries.size - most))) entries.delete(oldest)
}
