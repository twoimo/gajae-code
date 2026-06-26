#!/usr/bin/env bun

import { runCli } from "../cli";

await runCli(["--mode", "rpc-daemon-worker", "--no-session", "--no-title", "--no-lsp", ...process.argv.slice(2)]);
