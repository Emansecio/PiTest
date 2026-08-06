/**
 * BackgroundJobsSelectorComponent — the "N background tasks" panel (alt+j or
 * /jobs). Lists every tracked background bash job with live state; arrows
 * navigate, Enter dumps the selected job's buffered output into the transcript,
 * the kill key terminates it (the agent is notified via the job-event bus).
 *
 * The list refreshes from the registry on every lifecycle event and once per
 * second (elapsed columns), so a job exiting while the panel is open flips its
 * row in place instead of going stale.
 */

import { Container, getKeybindings, Spacer, Text, type TUI } from "@pit/tui";
import {
	type BashBackgroundJob,
	isBashBackgroundJobStalled,
	listBashBackgroundJobs,
	onBashBackgroundJobEvent,
} from "../../../core/tools/bash.ts";
import { theme } from "../theme/theme.ts";
import {
	HINT_SEPARATOR,
	keyHint,
	LIST_CLOSE_LABEL,
	LIST_NAVIGATE_LABEL,
	selectionCursor,
	themedScrollPositionHint,
} from "./keybinding-hints.ts";
import { SelectableRow } from "./selectable-row.ts";
import { beginSelectorSurface } from "./selector-surface.ts";

const MAX_VISIBLE = 10;

/** Compact elapsed: 45s, 3m12s, 1h04m. Dense — no spaces inside the token. */
export function formatJobElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** One-line state chip for a job row (glyph + label, themed). */
function jobStateChip(job: BashBackgroundJob, now: number): string {
	if (!job.exited) {
		if (job.stopUnconfirmed) return theme.fg("warning", "stop unconfirmed");
		if (isBashBackgroundJobStalled(job, now)) {
			const quietMs = now - Math.max(job.lastOutputAt, job.promotedAt);
			return theme.fg("warning", `▶ stalled ${formatJobElapsed(quietMs)}`);
		}
		return theme.fg("accent", `▶ ${formatJobElapsed(now - job.startedAt)}`);
	}
	if (job.exitCode === 0) return theme.fg("success", "✓ exit 0");
	if (job.exitCode === null) return theme.fg("warning", "✗ signaled");
	return theme.fg("error", `✗ exit ${job.exitCode}`);
}

export class BackgroundJobsSelectorComponent extends Container {
	private jobs: BashBackgroundJob[] = [];
	private selectedIndex = 0;
	private listContainer: Container;
	private onViewCallback: (job: BashBackgroundJob) => void;
	private onCancelCallback: () => void;
	private onKilledCallback: (job: BashBackgroundJob) => void;
	private tui: TUI | undefined;
	private ownerSessionId: string | undefined;
	private unsubscribeJobEvents: () => void;
	private refreshTimer: NodeJS.Timeout | undefined;

	constructor(options: {
		onView: (job: BashBackgroundJob) => void;
		onKilled: (job: BashBackgroundJob) => void;
		onCancel: () => void;
		tui?: TUI;
		ownerSessionId?: string;
	}) {
		super();
		this.onViewCallback = options.onView;
		this.onKilledCallback = options.onKilled;
		this.onCancelCallback = options.onCancel;
		this.tui = options.tui;
		this.ownerSessionId = options.ownerSessionId;

		const { surface: card, mount } = beginSelectorSurface(this, true);
		card.addChild(new Spacer(1));
		card.addChild(new Text(theme.bold(theme.fg("muted", "Background tasks")), 1, 0));
		card.addChild(new Spacer(1));
		this.listContainer = new Container();
		card.addChild(this.listContainer);
		card.addChild(new Spacer(1));
		card.addChild(
			new Text(
				theme.fg("dim", LIST_NAVIGATE_LABEL) +
					HINT_SEPARATOR +
					keyHint("tui.select.confirm", "output") +
					HINT_SEPARATOR +
					keyHint("app.jobs.kill", "kill") +
					HINT_SEPARATOR +
					keyHint("tui.select.cancel", LIST_CLOSE_LABEL),
				1,
				0,
			),
		);
		card.addChild(new Spacer(1));
		mount();

		// A job exiting/being killed while the panel is open flips its row live.
		this.unsubscribeJobEvents = onBashBackgroundJobEvent(() => {
			this.refresh();
			this.tui?.requestRender();
		});
		// Elapsed/stall columns tick once per second while the panel is up.
		this.refreshTimer = setInterval(() => {
			this.refresh();
			this.tui?.requestRender();
		}, 1000);
		this.refreshTimer.unref?.();

		this.refresh();
	}

	private refresh(): void {
		this.jobs = listBashBackgroundJobs(this.ownerSessionId).filter((job) => !job.stopping);
		if (this.selectedIndex >= this.jobs.length) {
			this.selectedIndex = Math.max(0, this.jobs.length - 1);
		}
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.jobs.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "No background tasks"), 1, 0));
			return;
		}

		const now = Date.now();
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.jobs.length - MAX_VISIBLE),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.jobs.length);

		for (let i = startIndex; i < endIndex; i++) {
			const job = this.jobs[i];
			const isSelected = i === this.selectedIndex;
			const cursor = selectionCursor(isSelected);
			// State chip + id lead the row so end-truncation only ever eats the
			// command tail, never the state. Dense `·` joins, no spaces.
			const chip = jobStateChip(job, now);
			const id = theme.fg(isSelected ? "accent" : "muted", job.id);
			const command = theme.fg(isSelected ? "accent" : "text", job.command.split("\n", 1)[0]);
			const sep = theme.fg("dim", "·");
			this.listContainer.addChild(
				new SelectableRow(`${cursor}${chip}${sep}${id}${sep}${command}`, isSelected, 1, () =>
					this.handleRowClick(i),
				),
			);
		}

		const scrollHint = themedScrollPositionHint(this.selectedIndex, this.jobs.length, startIndex, endIndex);
		if (scrollHint) {
			this.listContainer.addChild(new Text(scrollHint, 0, 0));
		}
	}

	/** Shared selector mouse contract: click moves the cursor, click again confirms. */
	private handleRowClick(index: number): void {
		if (index !== this.selectedIndex) {
			this.selectedIndex = index;
			this.updateList();
			return;
		}
		const job = this.jobs[index];
		if (job) this.onViewCallback(job);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			if (this.jobs.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.jobs.length - 1 : this.selectedIndex - 1;
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			if (this.jobs.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.jobs.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.home")) {
			if (this.jobs.length === 0) return;
			this.selectedIndex = 0;
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.end")) {
			if (this.jobs.length === 0) return;
			this.selectedIndex = this.jobs.length - 1;
			this.updateList();
		} else if (kb.matches(keyData, "app.jobs.kill")) {
			const job = this.jobs[this.selectedIndex];
			if (!job) return;
			this.onKilledCallback(job);
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const job = this.jobs[this.selectedIndex];
			if (job) this.onViewCallback(job);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.unsubscribeJobEvents();
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}
}
