import * as core from "@actions/core";
import { execFileSync } from "child_process";
import { appendFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const INSTALL_URL = "https://cli.kiro.dev/install";

/**
 * Resolves the Kiro CLI executable, installing it if necessary, and returns the
 * command to invoke.
 *
 * When `path_to_kiro_cli_executable` is set the binary is used as-is: that is
 * the supported way to pin a specific CLI version, since the install script
 * always fetches the latest release.
 */
export function installKiroCli(): string {
  const providedPath = process.env.PATH_TO_KIRO_CLI_EXECUTABLE;
  if (providedPath) {
    // Guard against control characters, which have no place in a path and would
    // be a red flag in a value that reaches a process invocation.
    if (/[\x00-\x1F\x7F]/.test(providedPath)) {
      throw new Error(
        "path_to_kiro_cli_executable contains control characters",
      );
    }
    if (!existsSync(providedPath)) {
      throw new Error(
        `path_to_kiro_cli_executable does not exist: ${providedPath}`,
      );
    }
    core.info(`Using the Kiro CLI at ${providedPath}`);
    return providedPath;
  }

  const localBin = join(homedir(), ".local", "bin");

  if (isOnPath("kiro-cli")) {
    core.info("Kiro CLI is already installed");
    return "kiro-cli";
  }

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      core.info(`Installing the Kiro CLI (attempt ${attempt}/${maxAttempts})`);
      // `set -o pipefail` so a failed download fails the install rather than
      // piping an error page into bash.
      execFileSync(
        "bash",
        ["-c", `set -o pipefail; curl -fsSL ${INSTALL_URL} | bash`],
        { stdio: "inherit", env: process.env },
      );
      break;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`Failed to install the Kiro CLI: ${error}`);
      }
      execFileSync("sleep", ["5"], { stdio: "ignore" });
    }
  }

  // The installer drops the binary in ~/.local/bin, which is not on PATH on all
  // runner images. Export it for this process and for later workflow steps.
  process.env.PATH = `${process.env.PATH}:${localBin}`;
  const githubPath = process.env.GITHUB_PATH;
  if (githubPath) {
    appendFileSync(githubPath, `${localBin}\n`);
  }

  if (!isOnPath("kiro-cli")) {
    const installed = join(localBin, "kiro-cli");
    if (existsSync(installed)) {
      return installed;
    }
    throw new Error(
      "The Kiro CLI was installed but 'kiro-cli' could not be found on PATH",
    );
  }

  return "kiro-cli";
}

function isOnPath(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore", env: process.env });
    return true;
  } catch {
    return false;
  }
}
