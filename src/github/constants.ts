/**
 * There is no official Kiro GitHub App, so commits and comments are attributed
 * to whichever identity the supplied token belongs to. The defaults below match
 * `github-actions[bot]`, which is what `${{ github.token }}` acts as.
 *
 * Override with the `bot_id` / `bot_name` inputs when using a GitHub App or a
 * personal access token.
 */
export const DEFAULT_BOT_ID = 41898282;
export const DEFAULT_BOT_LOGIN = "github-actions[bot]";

/** Default trigger phrase for tag mode. */
export const DEFAULT_TRIGGER_PHRASE = "@kiro";

/** Default prefix for branches the action creates. */
export const DEFAULT_BRANCH_PREFIX = "kiro/";

/** Name of the generated Kiro CLI custom agent. */
export const KIRO_AGENT_NAME = "kiro-action";
