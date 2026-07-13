#!/usr/bin/env node

import { runCli } from "../cli/program.js";

const exitCode = await runCli(process.argv, {
  forceExit: (code) => process.exit(code),
});
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
