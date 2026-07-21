import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export type FileContentStamp = { kind: "missing" } | { kind: "file"; sha256: string };

export function stampFileBytes(bytes: Uint8Array): Extract<FileContentStamp, { kind: "file" }> {
	return { kind: "file", sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function stampFile(path: string): Promise<Extract<FileContentStamp, { kind: "file" }>> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return { kind: "file", sha256: hash.digest("hex") };
}

export async function captureFileContentStamp(path: string): Promise<FileContentStamp> {
	try {
		return await stampFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		throw error;
	}
}

export async function fileContentStampMatches(path: string, expected: FileContentStamp): Promise<boolean> {
	try {
		const current = await stampFile(path);
		return expected.kind === "file" && current.sha256 === expected.sha256;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return expected.kind === "missing";
		throw error;
	}
}
