/**
 * Extracts the user's request from a trigger comment.
 *
 * Given a comment like "@kiro please check the auth module", this extracts
 * "please check the auth module".
 *
 * Uses string operations rather than a regex: comment bodies are attacker
 * controlled and can be very large, so this avoids any ReDoS surface.
 */
export function extractUserRequest(
  commentBody: string | undefined,
  triggerPhrase: string,
): string | null {
  if (!commentBody) {
    return null;
  }

  const triggerIndex = commentBody
    .toLowerCase()
    .indexOf(triggerPhrase.toLowerCase());
  if (triggerIndex === -1) {
    return null;
  }

  const afterTrigger = commentBody
    .substring(triggerIndex + triggerPhrase.length)
    .trim();
  return afterTrigger || null;
}
