import { Text } from "@pit/tui";
import type { ResourceDiagnostic } from "../../../core/diagnostics.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { formatDiagnostics } from "../display-utils.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { MessageShell } from "./message-shell.ts";

/**
 * Collapsible block for startup diagnostics (skill / prompt / extension /
 * theme conflicts and warnings).
 *
 * Collapsed: one-line summary with counts grouped by severity. Expanded:
 * the full `formatDiagnostics()` rendering. Reacts to ctrl+o because the
 * surrounding loop in `InteractiveMode.setToolsExpanded` invokes
 * `setExpanded` on every `chatContainer` child that implements it.
 *
 * Layout (Leva 2): block is rendered through the unified `MessageShell` with
 * a yellow gutter and the bracketed label (`[Skill conflicts]` etc.) on the
 * first content line. No `Spacer(1)` is added externally — the shell handles
 * the leading blank itself.
 */
export class DiagnosticsBlockComponent extends MessageShell {
	private expanded = false;
	private readonly diagnostics: readonly ResourceDiagnostic[];
	private readonly sourceInfos: Map<string, SourceInfo>;
	private readonly collapsedSummary?: (diagnostics: readonly ResourceDiagnostic[]) => string;

	constructor(
		label: string,
		diagnostics: readonly ResourceDiagnostic[],
		sourceInfos: Map<string, SourceInfo>,
		options?: { collapsedSummary?: (diagnostics: readonly ResourceDiagnostic[]) => string },
	) {
		// First-impression de-noise: only genuine errors warrant the saturated
		// diagnostics color on the gutter + bracketed label. Collisions/warnings
		// (the common startup case) sit in `muted` so the welcome screen isn't
		// dominated by a yellow bracket — the full detail is one ctrl+o away
		// regardless of severity.
		const hasError = diagnostics.some((d) => d.type === "error");
		super({
			gutterColor: (text: string) => theme.fg(hasError ? "gutterDiagnostics" : "muted", text),
			label,
		});
		this.diagnostics = diagnostics;
		this.sourceInfos = sourceInfos;
		this.collapsedSummary = options?.collapsedSummary;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (expanded === this.expanded) return;
		this.expanded = expanded;
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		if (this.expanded) {
			const body = formatDiagnostics(this.diagnostics, this.sourceInfos);
			this.addChild(new Text(body, 0, 0));
			return;
		}

		let summary: string;
		if (this.collapsedSummary) {
			summary = this.collapsedSummary(this.diagnostics);
		} else {
			let collisions = 0;
			let warnings = 0;
			let errors = 0;
			for (const d of this.diagnostics) {
				if (d.type === "collision") collisions++;
				else if (d.type === "error") errors++;
				else warnings++;
			}
			const parts: string[] = [];
			if (collisions > 0) parts.push(`${collisions} ${collisions === 1 ? "collision" : "collisions"}`);
			if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`);
			if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`);
			summary = parts.length > 0 ? parts.join(" · ") : `${this.diagnostics.length} issues`;
		}

		const line = `${theme.fg("dim", summary)} ${theme.fg("dim", `(${keyText("app.tools.expand")} to expand)`)}`;
		this.addChild(new Text(line, 0, 0));
	}
}
