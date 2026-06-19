import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const cjsRequire = createRequire(import.meta.url);

/** Windows code page identifier for UTF-8. */
const CP_UTF8 = 65001;

/**
 * Force the Windows console into UTF-8 mode so accented characters (e.g. the
 * Portuguese "c-cedilla" / "a-tilde" in "Verificacao") render correctly instead
 * of mojibake.
 *
 * Background: on a pt-BR Windows install the console defaults to code page 1252
 * (cp1252). When Node writes UTF-8 bytes to a redirected/piped stream - or when
 * a non-Unicode-aware consumer reads them - each UTF-8 byte is reinterpreted as
 * a cp1252 character, so a 2-byte sequence like 0xC3 0xA7 shows up as two
 * garbled glyphs and, after a second round-trip, four. Switching the console's
 * input AND output code pages to 65001 keeps the whole pipeline on UTF-8 and
 * eliminates the garbling.
 *
 * We call the kernel32 SetConsoleOutputCP/SetConsoleCP APIs directly via koffi
 * because that reliably affects the *current* process console, unlike spawning
 * `chcp` in a child `cmd` (which can fail silently or not propagate). The koffi
 * require is dynamic so its large native payload is never bundled, and we fall
 * back to `chcp 65001` when koffi is unavailable.
 */
export function ensureWindowsUtf8Console(): void {
	if (process.platform !== "win32") return;

	if (trySetConsoleCodePageViaApi()) return;

	// Fallback: koffi unavailable (e.g. stripped build). chcp still helps for
	// the common interactive case even though it is less reliable.
	try {
		execSync(`chcp ${CP_UTF8}`, { stdio: "ignore" });
	} catch {
		// Best effort - nothing else we can do.
	}
}

function trySetConsoleCodePageViaApi(): boolean {
	try {
		// Dynamic require to avoid bundling koffi's cross-platform native
		// binaries. Koffi is only needed on Windows.
		const koffi = cjsRequire("koffi");
		const k32 = koffi.load("kernel32.dll");
		const SetConsoleOutputCP = k32.func("bool __stdcall SetConsoleOutputCP(uint32_t)");
		const SetConsoleCP = k32.func("bool __stdcall SetConsoleCP(uint32_t)");

		// Output CP controls how bytes we write are interpreted; input CP controls
		// how typed characters are decoded. Set both so describing text and typing
		// accented input both stay UTF-8.
		const okOut = SetConsoleOutputCP(CP_UTF8);
		const okIn = SetConsoleCP(CP_UTF8);
		return Boolean(okOut || okIn);
	} catch {
		return false;
	}
}
