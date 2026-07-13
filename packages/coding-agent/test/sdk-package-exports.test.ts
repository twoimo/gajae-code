import { describe, expect, it } from "bun:test";
import * as publicSdk from "@gajae-code/coding-agent/sdk";
import * as bus from "@gajae-code/coding-agent/sdk/bus";
import * as root from "../src/index";
import * as sdk from "../src/sdk";
import * as session from "../src/sdk/session";

describe("SDK package exports", () => {
	it("preserves the session SDK surface and bus namespace after the namespace move", () => {
		for (const exportName of Object.keys(session)) expect(sdk).toHaveProperty(exportName);
		expect(sdk).toHaveProperty("bus");
		expect(root).toHaveProperty("createAgentSession");
	});

	it("loads the public SDK and bus package subpaths", () => {
		expect(publicSdk.createAgentSession).toBeFunction();
		expect(bus.createNotificationsExtension).toBeFunction();
	});
});
