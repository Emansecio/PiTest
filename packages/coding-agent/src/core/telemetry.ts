import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import type { SettingsManager } from "./settings-manager.ts";

export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.PIT_TELEMETRY,
): boolean {
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
