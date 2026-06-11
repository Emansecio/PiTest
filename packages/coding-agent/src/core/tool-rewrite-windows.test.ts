/**
 * Unit coverage for the Windows shell-syntax normalisers that back the Tier-1
 * `bash-windows-shell-normalize` auto rewrite. Each helper is pure and platform-
 * parameterised so the assertions hold regardless of the host OS.
 */

import { describe, expect, it } from "vitest";
import {
	normalizeWindowsBashCommand,
	rewriteNulRedirect,
	rewriteUnixDrivePathOnWindows,
	rewriteUnquotedDriveBackslashes,
} from "./tool-rewrite-rules.ts";

describe("rewriteUnquotedDriveBackslashes", () => {
	it("converts an unquoted drive path's backslashes to forward slashes", () => {
		expect(rewriteUnquotedDriveBackslashes("rg foo C:\\Users\\PiTest")).toBe("rg foo C:/Users/PiTest");
	});

	it("handles a lower-case drive letter and a trailing segment", () => {
		expect(rewriteUnquotedDriveBackslashes("cat d:\\work\\a.ts")).toBe("cat d:/work/a.ts");
	});

	it("leaves a single-quoted path untouched (bash already passes it verbatim)", () => {
		expect(rewriteUnquotedDriveBackslashes("rg foo 'C:\\Users\\PiTest'")).toBe("rg foo 'C:\\Users\\PiTest'");
	});

	it("leaves a double-quoted path untouched", () => {
		expect(rewriteUnquotedDriveBackslashes('rg foo "C:\\Users\\x"')).toBe('rg foo "C:\\Users\\x"');
	});

	it("does NOT touch regex backslashes with no drive-letter prefix", () => {
		expect(rewriteUnquotedDriveBackslashes("grep '\\bfoo\\b' file")).toBe("grep '\\bfoo\\b' file");
		expect(rewriteUnquotedDriveBackslashes("sed 's/\\n//' file")).toBe("sed 's/\\n//' file");
	});

	it("stops at a shell delimiter and is idempotent on forward-slash paths", () => {
		expect(rewriteUnquotedDriveBackslashes("ls C:\\a\\b | wc -l")).toBe("ls C:/a/b | wc -l");
		expect(rewriteUnquotedDriveBackslashes("rg foo C:/Users/x")).toBe("rg foo C:/Users/x");
	});
});

describe("rewriteNulRedirect", () => {
	it("rewrites 2>nul to 2>/dev/null", () => {
		expect(rewriteNulRedirect("rg foo bar 2>nul")).toBe("rg foo bar 2>/dev/null");
	});

	it("rewrites 1>nul and bare >nul", () => {
		expect(rewriteNulRedirect("cmd 1>nul")).toBe("cmd 1>/dev/null");
		expect(rewriteNulRedirect("cmd >nul")).toBe("cmd >/dev/null");
	});

	it("is case-insensitive on the NUL device and idempotent", () => {
		expect(rewriteNulRedirect("cmd 2>NUL")).toBe("cmd 2>/dev/null");
		expect(rewriteNulRedirect("cmd 2>/dev/null")).toBe("cmd 2>/dev/null");
	});

	it("does not touch a file literally named nullable", () => {
		expect(rewriteNulRedirect("cat nullable.txt")).toBe("cat nullable.txt");
	});
});

describe("rewriteUnixDrivePathOnWindows", () => {
	it("rewrites /c/Users to C:/Users on win32", () => {
		expect(rewriteUnixDrivePathOnWindows("cat /c/Users/x", "win32")).toBe("cat C:/Users/x");
	});

	it("is a no-op on non-win32 platforms (a real /c/ dir can exist)", () => {
		expect(rewriteUnixDrivePathOnWindows("cat /c/Users/x", "linux")).toBe("cat /c/Users/x");
	});

	it("does not touch a quoted /c/ inside a sed program", () => {
		expect(rewriteUnixDrivePathOnWindows("sed 's|/c/|/d/|' f", "win32")).toBe("sed 's|/c/|/d/|' f");
	});

	it("does not corrupt /dev/null (multi-char segment is not a drive letter)", () => {
		expect(rewriteUnixDrivePathOnWindows("cmd 2>/dev/null", "win32")).toBe("cmd 2>/dev/null");
	});
});

describe("normalizeWindowsBashCommand", () => {
	it("fixes a command with several Windows issues at once", () => {
		expect(normalizeWindowsBashCommand("rg foo C:\\Users\\PiTest 2>nul", "win32")).toBe(
			"rg foo C:/Users/PiTest 2>/dev/null",
		);
	});

	it("returns the input unchanged when there is nothing to fix", () => {
		const clean = "rg foo C:/Users/x 2>/dev/null";
		expect(normalizeWindowsBashCommand(clean, "win32")).toBe(clean);
	});
});
