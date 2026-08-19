#!/usr/bin/env node

/**
 * Bundle entry point. Exists so nothing depends on `import.meta.main`, which is
 * only available from Node v24.2.0 and v22.18.0: on anything older the guard it
 * replaced was simply falsy, and the action would have exited successfully
 * without doing any work — the least detectable way for this to break.
 */

import { run } from "./run";

run().then(() => {
  // Exit explicitly rather than waiting for the event loop to drain: the CLI's
  // KAS server can outlive it and keep a handle open, and core.setFailed has
  // already set the exit code by this point.
  process.exit(process.exitCode ?? 0);
});
