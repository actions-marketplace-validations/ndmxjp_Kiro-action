import * as core from "@actions/core";

/**
 * Validates the environment the Kiro CLI needs, and normalizes it for CI.
 *
 * `KIRO_API_KEY` is the CLI's only supported non-interactive credential.
 */
export function prepareKiroEnvironment(): void {
  const apiKey = process.env.KIRO_API_KEY;
  if (!apiKey) {
    throw new Error(
      "KIRO_API_KEY is required. Pass it via the `kiro_api_key` input, e.g. " +
        "`kiro_api_key: ${{ secrets.KIRO_API_KEY }}`.",
    );
  }

  // Registering the key as a secret keeps it masked in the job log even if the
  // CLI (or a failing command) echoes it.
  core.setSecret(apiKey);

  // The CLI renders progress with ANSI colors and spinners by default, which
  // turn into unreadable escape sequences in a workflow log.
  process.env.KIRO_LOG_NO_COLOR = "1";
  process.env.NO_COLOR = "1";
  process.env.TERM = "dumb";
}
