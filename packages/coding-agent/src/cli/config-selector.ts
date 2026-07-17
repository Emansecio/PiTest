/**
 * TUI config selector for `pit config` command
 */

import { ProcessTerminal, TUI } from "@pit/tui";
import type { ResolvedPaths } from "../core/package-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ConfigSelectorComponent } from "../modes/interactive/components/config-selector.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";
import { withTuiSignalGuard } from "./with-tui-signal-guard.ts";

export interface ConfigSelectorOptions {
	resolvedPaths: ResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
}

/** Show TUI config selector and return when closed */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// Initialize theme before showing TUI
	initTheme(options.settingsManager.getTheme(), true);

	const ui = new TUI(new ProcessTerminal());
	return withTuiSignalGuard(
		ui,
		() =>
			new Promise<void>((resolve) => {
				let resolved = false;

				const selector = new ConfigSelectorComponent(
					options.resolvedPaths,
					options.settingsManager,
					options.cwd,
					options.agentDir,
					() => {
						if (!resolved) {
							resolved = true;
							ui.stop();
							stopThemeWatcher();
							resolve();
						}
					},
					() => {
						ui.stop();
						stopThemeWatcher();
						process.exit(0);
					},
					() => ui.requestRender(),
					() => ui.terminal.rows,
				);

				ui.addChild(selector);
				ui.setFocus(selector.getResourceList());
				ui.start();
			}),
	);
}
