import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Broker } from "../src/sdk/broker/broker";
describe("SDK broker restart", () => { it("takes over a stale lock and rotates discovery token", async () => { const dir=await fs.mkdtemp(path.join(process.env.TMPDIR??"/tmp","gjc-restart-")); const a=new Broker({agentDir:dir}); const first=await a.start(); await a.stop(); const b=new Broker({agentDir:dir}); const second=await b.start(); expect(second.token).not.toBe(first.token); await b.stop(); }); });
