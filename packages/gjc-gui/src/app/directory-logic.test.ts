import { describe, expect, test } from "bun:test";
import {
	normalizeDirectoryInput,
	readRecentDirectories,
	recentDirectoryDisplay,
	redactDirectoryPath,
	rememberDirectoryValue,
	type StorageLike,
	writeRecentDirectories,
} from "./directory-logic";
import { startChatDecision } from "./first-run-logic";

function memoryStorage(): StorageLike {
	const entries = new Map<string, string>();
	return {
		getItem: key => entries.get(key) ?? null,
		setItem: (key, value) => entries.set(key, value),
	};
}

describe("directory logic", () => {
	test("validates absolute paths only", () => {
		expect(normalizeDirectoryInput(" /Users/example/project ")).toBe("/Users/example/project");
		expect(normalizeDirectoryInput("C:\\work\\repo")).toBe("C:\\work\\repo");
		expect(normalizeDirectoryInput("relative/path")).toBe("");
		expect(normalizeDirectoryInput("/tmp/")).toBe("/tmp");
		expect(normalizeDirectoryInput("/")).toBe("/");
	});

	test("decides scratch vs project start", () => {
		expect(startChatDecision("")).toEqual({ kind: "scratch", cwd: "/tmp" });
		expect(startChatDecision("/tmp/")).toEqual({ kind: "scratch", cwd: "/tmp" });
		expect(startChatDecision("/repo")).toEqual({ kind: "project", cwd: "/repo" });
		expect(startChatDecision("relative")).toEqual({ kind: "invalid-directory" });
	});

	test("stores recent directories newest first", () => {
		const storage = memoryStorage();
		writeRecentDirectories(storage, rememberDirectoryValue([], "/repo/a"));
		writeRecentDirectories(storage, rememberDirectoryValue(readRecentDirectories(storage), "/repo/b"));
		expect(readRecentDirectories(storage)).toEqual(["/repo/b", "/repo/a"]);
	});

	test("recent display is basename-first, redacted, and truncated", () => {
		expect(recentDirectoryDisplay("/Users/realname/secret-project", 64)).toBe("secret-project — ~/secret-project");
		expect(recentDirectoryDisplay("C:\\Users\\alice\\secret-project", 64)).toBe("secret-project — ~\\secret-project");
		expect(recentDirectoryDisplay("C:/Users/alice/secret-project", 64)).toBe("secret-project — ~/secret-project");
		expect(recentDirectoryDisplay("/Users/realname")).toBe("~");
		expect(recentDirectoryDisplay("/repo/very-long-project-name", 10)).toBe("very-long…");
	});

	test("redacts Windows home paths for titles and displays", () => {
		expect(redactDirectoryPath("C:\\Users\\alice\\secret-project")).toBe("~\\secret-project");
		expect(redactDirectoryPath("C:/Users/alice/secret-project")).toBe("~/secret-project");
		expect(redactDirectoryPath("C:\\Users\\alice")).toBe("~");
		expect(redactDirectoryPath("C:/Users/alice")).toBe("~");
		expect(redactDirectoryPath("c:\\users\\alice\\secret-project")).toBe("~\\secret-project");
		expect(redactDirectoryPath("c:/users/alice/secret-project")).toBe("~/secret-project");
		expect(redactDirectoryPath("C:\\users\\Alice\\secret-project")).toBe("~\\secret-project");
		expect(redactDirectoryPath("/users/realname/secret-project")).toBe("~/secret-project");
	});
});
