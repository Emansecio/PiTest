import { getUserName } from "./user.mjs";

export function greetA(u) {
	return `Hi ${getUserName(u)}`;
}
