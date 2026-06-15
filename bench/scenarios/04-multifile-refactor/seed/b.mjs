import { getUserName } from "./user.mjs";

export function greetB(u) {
	return `Hello ${getUserName(u)}`;
}
