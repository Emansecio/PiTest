export { describeToolAction, PermissionChecker } from "./checker.ts";
export {
	findMatchingCommandRule,
	findMatchingGlob,
	globToRegExp,
	matchGlob,
	normalizeTargetPath,
} from "./matcher.ts";
export type {
	CommandRule,
	PathRule,
	PermissionAction,
	PermissionDecision,
	PermissionMode,
	PermissionSettings,
} from "./types.ts";
export {
	BUILTIN_DANGEROUS_COMMANDS,
	BUILTIN_SENSITIVE_PATHS,
	isPermissionMode,
	normalizePermissionMode,
	PERMISSION_MODES,
} from "./types.ts";
