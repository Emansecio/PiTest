import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactForDisk } from "../secret-redactor.ts";
import { assertFindingTransition, type FindingEvent, type FindingState } from "./finding-lifecycle.ts";

interface StoredFindingRecord {
	type: "finding";
	eventId: string;
	timestamp: string;
	findingId: string;
	event: FindingEvent;
}

interface StoredArtifactRecord {
	type: "artifact";
	eventId: string;
	timestamp: string;
	findingId: string;
	name: string;
	content: string;
}

type StoredRecord = StoredFindingRecord | StoredArtifactRecord;

export interface FindingSummary {
	findingId: string;
	state: FindingState;
	summary: string;
	eventCount: number;
}

function workspaceKey(cwd: string): string {
	return createHash("sha256").update(cwd.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 16);
}

export class SecurityEvidenceStore {
	readonly path: string;

	constructor(baseDir: string, cwd: string) {
		this.path = join(baseDir, "security-evidence", workspaceKey(cwd), "evidence.jsonl");
	}

	appendFinding(findingId: string, event: FindingEvent): StoredFindingRecord {
		const history = this.get(findingId).map((record) => record.event);
		assertFindingTransition(history, event);
		const record: StoredFindingRecord = {
			type: "finding",
			eventId: randomUUID(),
			timestamp: new Date().toISOString(),
			findingId,
			event,
		};
		this.append(record);
		return record;
	}

	appendArtifact(findingId: string, name: string, content: string): StoredArtifactRecord {
		const record: StoredArtifactRecord = {
			type: "artifact",
			eventId: randomUUID(),
			timestamp: new Date().toISOString(),
			findingId,
			name,
			content,
		};
		this.append(record);
		return record;
	}

	get(findingId: string): StoredFindingRecord[] {
		return this.readAll().filter(
			(record): record is StoredFindingRecord => record.type === "finding" && record.findingId === findingId,
		);
	}

	list(): FindingSummary[] {
		const grouped = new Map<string, StoredFindingRecord[]>();
		for (const record of this.readAll()) {
			if (record.type !== "finding") continue;
			const group = grouped.get(record.findingId);
			if (group) group.push(record);
			else grouped.set(record.findingId, [record]);
		}
		return [...grouped.entries()]
			.map(([findingId, records]) => {
				const latest = records.at(-1) as StoredFindingRecord;
				return {
					findingId,
					state: latest.event.state,
					summary: latest.event.summary ?? (latest.event.state === "retracted" ? latest.event.reason : ""),
					eventCount: records.length,
				};
			})
			.sort((a, b) => a.findingId.localeCompare(b.findingId));
	}

	private append(record: StoredRecord): void {
		mkdirSync(join(this.path, ".."), { recursive: true });
		appendFileSync(this.path, `${redactForDisk(JSON.stringify(record))}\n`, "utf8");
	}

	private readAll(): StoredRecord[] {
		if (!existsSync(this.path)) return [];
		return readFileSync(this.path, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as StoredRecord];
				} catch {
					return [];
				}
			});
	}
}
