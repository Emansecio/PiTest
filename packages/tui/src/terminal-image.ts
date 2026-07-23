export type ImageProtocol = "kitty" | "iterm2" | null;

export interface TerminalCapabilities {
	images: ImageProtocol;
	trueColor: boolean;
	hyperlinks: boolean;
	/**
	 * Best-effort *env-time* guess at sixel support. Env vars almost never
	 * confirm sixel positively, so this is usually `false`; the authoritative
	 * answer comes from the runtime DA1 query (see {@link getSixelSupport}).
	 * Optional so pre-existing `TerminalCapabilities` literals keep compiling —
	 * absent is treated as `false`.
	 */
	sixel?: boolean;
}

/** Truthy for "1"/"true"/"yes" (case-insensitive). Local copy so @pit/tui keeps
 * no dependency on the coding-agent env-flag helpers. */
function isTruthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface ImageRenderOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	preserveAspectRatio?: boolean;
	/** Kitty image ID. If provided, reuses/replaces existing image with this ID. */
	imageId?: number;
	/** Whether Kitty should apply its default cursor movement after placement. */
	moveCursor?: boolean;
}

let cachedCapabilities: TerminalCapabilities | null = null;

// Default cell dimensions - updated by TUI when terminal responds to query
let cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 };

export function getCellDimensions(): CellDimensions {
	return cellDimensions;
}

export function setCellDimensions(dims: CellDimensions): void {
	cellDimensions = dims;
}

export function detectCapabilities(): TerminalCapabilities {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
	const hasTrueColorHint = colorTerm === "truecolor" || colorTerm === "24bit";

	// tmux and screen swallow OSC 8 by default (passthrough is opt-in and wraps
	// sequences differently). Force hyperlinks off whenever we detect them, even
	// when the outer terminal would otherwise support OSC 8. Image protocols and
	// sixel are also unreliable under tmux/screen, so leave both off for safety.
	const inTmuxOrScreen = !!process.env.TMUX || term.startsWith("tmux") || term.startsWith("screen");
	if (inTmuxOrScreen) {
		return { images: null, trueColor: hasTrueColorHint, hyperlinks: false, sixel: false };
	}

	// Env can rarely confirm sixel positively; the DA1 runtime query is the real
	// detector. Only an explicit `PIT_FORCE_SIXEL` opts a session in at env time.
	const sixel = isTruthyEnv(process.env.PIT_FORCE_SIXEL);

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		return { images: "kitty", trueColor: true, hyperlinks: true, sixel };
	}

	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		return { images: "kitty", trueColor: true, hyperlinks: true, sixel };
	}

	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		return { images: "kitty", trueColor: true, hyperlinks: true, sixel };
	}

	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		return { images: "iterm2", trueColor: true, hyperlinks: true, sixel };
	}

	if (termProgram === "vscode") {
		return { images: null, trueColor: true, hyperlinks: true, sixel };
	}

	if (termProgram === "alacritty") {
		return { images: null, trueColor: true, hyperlinks: true, sixel };
	}

	// Unknown terminal: be conservative. OSC 8 is rendered invisibly as "just
	// text" on terminals that swallow it, which means the URL disappears from
	// the rendered output. Default to the legacy `text (url)` behavior unless we
	// have positively identified a hyperlink-capable terminal above.
	return { images: null, trueColor: hasTrueColorHint || !!process.env.WT_SESSION, hyperlinks: false, sixel };
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		cachedCapabilities = detectCapabilities();
	}
	return cachedCapabilities;
}

export function resetCapabilitiesCache(): void {
	cachedCapabilities = null;
}

/** Override the cached capabilities. Useful in tests to exercise both code paths. */
export function setCapabilities(caps: TerminalCapabilities): void {
	cachedCapabilities = caps;
}

// --- Sixel support ----------------------------------------------------------
// Env detection is weak, so the real answer is a runtime DA1 query. Until that
// lands, callers see the conservative env guess (usually false → cell fallback);
// once it resolves, `sixelRuntimeSupport` is authoritative.
let sixelRuntimeSupport: boolean | undefined;

/** True when `PIT_NO_SIXEL` forces the cell fallback regardless of capability. */
export function isSixelForcedOff(): boolean {
	return isTruthyEnv(process.env.PIT_NO_SIXEL);
}

/**
 * Whether to emit sixel. Honors the `PIT_NO_SIXEL` kill switch first, then the
 * runtime DA1 result, then the env-time guess. Never throws — safe to call on
 * every render.
 */
export function getSixelSupport(): boolean {
	if (isSixelForcedOff()) return false;
	if (sixelRuntimeSupport !== undefined) return sixelRuntimeSupport;
	return getCapabilities().sixel === true;
}

/**
 * True once we have a *definite* answer (kill switch, resolved DA1 query, or a
 * positive env guess). Lets the welcome default to cells before the query lands
 * without committing to "no sixel" prematurely.
 */
export function isSixelSupportKnown(): boolean {
	return isSixelForcedOff() || sixelRuntimeSupport !== undefined || getCapabilities().sixel === true;
}

/** Record the runtime DA1 result (or a test override). */
export function setSixelSupport(supported: boolean): void {
	sixelRuntimeSupport = supported;
}

/** Clear the runtime DA1 result (tests). */
export function resetSixelSupport(): void {
	sixelRuntimeSupport = undefined;
}

/**
 * Parse a Primary Device Attributes (DA1) response and report whether the
 * terminal advertised sixel graphics (attribute `4`).
 *
 * DA1 reply shape: `ESC [ ? p1 ; p2 ; … c` (e.g. `ESC[?62;4;6c`). Returns
 * `undefined` when `data` is not a DA1 response at all, so callers can keep
 * waiting instead of treating unrelated input as "no sixel".
 */
export function parseSixelDeviceAttributes(data: string): boolean | undefined {
	const match = data.match(/\x1b\[\?([0-9;]+)c/);
	if (!match) return undefined;
	return match[1]!.split(";").includes("4");
}

const KITTY_PREFIX = "\x1b_G";
const ITERM2_PREFIX = "\x1b]1337;File=";
// Sixel DCS introducer. The pet sixel line wraps the sequence in cursor
// save/restore, so the DCS may sit mid-line — matched by the slow path below.
const SIXEL_PREFIX = "\x1bP";

export function isImageLine(line: string): boolean {
	// Fast path: sequence at line start (single-row images)
	if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX) || line.startsWith(SIXEL_PREFIX)) {
		return true;
	}
	// Slow path: sequence elsewhere (multi-row images have a cursor-move prefix)
	return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX) || line.includes(SIXEL_PREFIX);
}

/**
 * Generate a random image ID for Kitty graphics protocol.
 * Uses random IDs to avoid collisions between different module instances
 * (e.g., main app vs extensions).
 */
export function allocateImageId(): number {
	// Use random ID in range [1, 0xffffffff] to avoid collisions
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

export function encodeKitty(
	base64Data: string,
	options: {
		columns?: number;
		rows?: number;
		imageId?: number;
		/** Whether Kitty should apply its default cursor movement after placement. Default: true. */
		moveCursor?: boolean;
	} = {},
): string {
	const CHUNK_SIZE = 4096;

	const params: string[] = ["a=T", "f=100", "q=2"];

	if (options.moveCursor === false) params.push("C=1");
	if (options.columns) params.push(`c=${options.columns}`);
	if (options.rows) params.push(`r=${options.rows}`);
	if (options.imageId) params.push(`i=${options.imageId}`);

	if (base64Data.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64Data}\x1b\\`;
	}

	const chunks: string[] = [];
	let offset = 0;
	let isFirst = true;

	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;

		if (isFirst) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
			isFirst = false;
		} else if (isLast) {
			chunks.push(`\x1b_Gm=0;${chunk}\x1b\\`);
		} else {
			chunks.push(`\x1b_Gm=1;${chunk}\x1b\\`);
		}

		offset += CHUNK_SIZE;
	}

	return chunks.join("");
}

/**
 * Delete a Kitty graphics image by ID.
 * Uses uppercase 'I' to also free the image data.
 */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/**
 * Delete all visible Kitty graphics images.
 * Uses uppercase 'A' to also free the image data.
 */
export function deleteAllKittyImages(): string {
	return "\x1b_Ga=d,d=A,q=2\x1b\\";
}

export function encodeITerm2(
	base64Data: string,
	options: {
		width?: number | string;
		height?: number | string;
		name?: string;
		preserveAspectRatio?: boolean;
		inline?: boolean;
	} = {},
): string {
	const params: string[] = [`inline=${options.inline !== false ? 1 : 0}`];

	if (options.width !== undefined) params.push(`width=${options.width}`);
	if (options.height !== undefined) params.push(`height=${options.height}`);
	if (options.name) {
		const nameBase64 = Buffer.from(options.name).toString("base64");
		params.push(`name=${nameBase64}`);
	}
	if (options.preserveAspectRatio === false) {
		params.push("preserveAspectRatio=0");
	}

	return `\x1b]1337;File=${params.join(";")}:${base64Data}\x07`;
}

export interface ImageCellSize {
	columns: number;
	rows: number;
}

export function calculateImageCellSize(
	imageDimensions: ImageDimensions,
	maxWidthCells: number,
	maxHeightCells?: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): ImageCellSize {
	const maxWidth = Math.max(1, Math.floor(maxWidthCells));
	const maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells));
	const imageWidth = Math.max(1, imageDimensions.widthPx);
	const imageHeight = Math.max(1, imageDimensions.heightPx);

	const widthScale = (maxWidth * cellDimensions.widthPx) / imageWidth;
	const heightScale = maxHeight === undefined ? widthScale : (maxHeight * cellDimensions.heightPx) / imageHeight;
	const scale = Math.min(widthScale, heightScale);

	const scaledWidthPx = imageWidth * scale;
	const scaledHeightPx = imageHeight * scale;
	const columns = Math.ceil(scaledWidthPx / cellDimensions.widthPx);
	const rows = Math.ceil(scaledHeightPx / cellDimensions.heightPx);

	return {
		columns: Math.max(1, Math.min(maxWidth, columns)),
		rows: Math.max(1, maxHeight === undefined ? rows : Math.min(maxHeight, rows)),
	};
}

export function calculateImageRows(
	imageDimensions: ImageDimensions,
	targetWidthCells: number,
	cellDimensions: CellDimensions = { widthPx: 9, heightPx: 18 },
): number {
	return calculateImageCellSize(imageDimensions, targetWidthCells, undefined, cellDimensions).rows;
}

// Only the fixed-size header needs decoding to read width/height — not the
// full (possibly multi-MB) base64 payload. 64 base64 chars decode to 48
// bytes, comfortably covering PNG's 24-byte IHDR window, GIF's 10-byte
// logical screen descriptor, and every WEBP chunk variant (VP8/VP8L/VP8X top
// out at 30 bytes read — see getWebpDimensions). Kept a multiple of 4 so the
// decoded prefix's leading bytes are byte-for-byte identical to decoding the
// full string (base64 decodes in 4-char/3-byte groups): this is not an
// approximation, it reproduces the exact same header bytes the old
// decode-everything code read, for both valid and truncated/invalid input.
const HEADER_PROBE_BASE64_CHARS = 64;

function probeHeaderBuffer(base64Data: string): Buffer {
	const truncated =
		base64Data.length > HEADER_PROBE_BASE64_CHARS ? base64Data.slice(0, HEADER_PROBE_BASE64_CHARS) : base64Data;
	return Buffer.from(truncated, "base64");
}

export function getPngDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = probeHeaderBuffer(base64Data);

		if (buffer.length < 24) {
			return null;
		}

		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
			return null;
		}

		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getJpegDimensions(base64Data: string): ImageDimensions | null {
	try {
		const maxBase64Chars = 131072;
		const truncated = base64Data.length > maxBase64Chars ? base64Data.slice(0, maxBase64Chars) : base64Data;
		const buffer = Buffer.from(truncated, "base64");

		if (buffer.length < 2) {
			return null;
		}

		if (buffer[0] !== 0xff || buffer[1] !== 0xd8) {
			return null;
		}

		let offset = 2;
		while (offset < buffer.length - 9) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}

			const marker = buffer[offset + 1];

			if (marker >= 0xc0 && marker <= 0xc2) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { widthPx: width, heightPx: height };
			}

			if (offset + 3 >= buffer.length) {
				return null;
			}
			const length = buffer.readUInt16BE(offset + 2);
			if (length < 2) {
				return null;
			}
			offset += 2 + length;
		}

		return null;
	} catch {
		return null;
	}
}

export function getGifDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = probeHeaderBuffer(base64Data);

		if (buffer.length < 10) {
			return null;
		}

		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") {
			return null;
		}

		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);

		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

export function getWebpDimensions(base64Data: string): ImageDimensions | null {
	try {
		const buffer = probeHeaderBuffer(base64Data);

		if (buffer.length < 30) {
			return null;
		}

		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") {
			return null;
		}

		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}

		return null;
	} catch {
		return null;
	}
}

export function getImageDimensions(base64Data: string, mimeType: string): ImageDimensions | null {
	if (mimeType === "image/png") {
		return getPngDimensions(base64Data);
	}
	if (mimeType === "image/jpeg") {
		return getJpegDimensions(base64Data);
	}
	if (mimeType === "image/gif") {
		return getGifDimensions(base64Data);
	}
	if (mimeType === "image/webp") {
		return getWebpDimensions(base64Data);
	}
	return null;
}

export function renderImage(
	base64Data: string,
	imageDimensions: ImageDimensions,
	options: ImageRenderOptions = {},
): { sequence: string; rows: number; imageId?: number } | null {
	const caps = getCapabilities();

	if (!caps.images) {
		return null;
	}

	const maxWidth = options.maxWidthCells ?? 80;
	const size = calculateImageCellSize(imageDimensions, maxWidth, options.maxHeightCells, getCellDimensions());

	if (caps.images === "kitty") {
		const sequence = encodeKitty(base64Data, {
			columns: size.columns,
			rows: size.rows,
			imageId: options.imageId,
			moveCursor: options.moveCursor,
		});
		return { sequence, rows: size.rows, imageId: options.imageId };
	}

	if (caps.images === "iterm2") {
		const sequence = encodeITerm2(base64Data, {
			width: size.columns,
			height: "auto",
			preserveAspectRatio: options.preserveAspectRatio ?? true,
		});
		return { sequence, rows: size.rows };
	}

	return null;
}

/**
 * Wrap text in an OSC 8 hyperlink sequence.
 * The text is rendered as a clickable hyperlink in terminals that support OSC 8
 * (Ghostty, Kitty, WezTerm, iTerm2, VSCode, and others).
 * In terminals that do not support OSC 8, the escape sequences are ignored
 * and only the plain text is displayed.
 *
 * @param text - The visible text to display
 * @param url - The URL to link to
 */
export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function imageFallback(mimeType: string, dimensions?: ImageDimensions, filename?: string): string {
	const parts: string[] = [];
	if (filename) parts.push(filename);
	parts.push(`[${mimeType}]`);
	if (dimensions) parts.push(`${dimensions.widthPx}x${dimensions.heightPx}`);
	return `[Image: ${parts.join(" ")}]`;
}
