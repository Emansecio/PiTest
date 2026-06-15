import { getUserName } from "./user.mjs";

export function labelC(u) {
	return getUserName(u).toUpperCase();
}
