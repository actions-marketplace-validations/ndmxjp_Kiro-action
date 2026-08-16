/**
 * Parses an actor filter string into an array of patterns.
 * @param filterString - Comma-separated actor names (e.g., "user1,user2,*[bot]")
 */
export function parseActorFilter(filterString: string): string[] {
  if (!filterString.trim()) return [];
  return filterString
    .split(",")
    .map((actor) => actor.trim())
    .filter((actor) => actor.length > 0);
}

/**
 * Checks if an actor matches a pattern.
 * Supports one wildcard: "*[bot]" matches every bot account.
 */
export function actorMatchesPattern(actor: string, pattern: string): boolean {
  if (actor === pattern) return true;
  if (pattern === "*[bot]" && actor.endsWith("[bot]")) return true;
  return false;
}

/**
 * Determines whether a comment should be included based on the actor filters.
 * Exclusion takes priority over inclusion.
 */
export function shouldIncludeCommentByActor(
  actor: string,
  includeActors: string[],
  excludeActors: string[],
): boolean {
  for (const pattern of excludeActors) {
    if (actorMatchesPattern(actor, pattern)) {
      return false;
    }
  }

  if (includeActors.length > 0) {
    return includeActors.some((pattern) => actorMatchesPattern(actor, pattern));
  }

  return true;
}
