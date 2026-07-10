/**
 * Rounded card frame for overlays/selectors — same visual idiom as the welcome
 * card and tool MessageShell frames. Thin wrapper over {@link Card} from `@pit/tui`
 * with theme defaults (`cardBg` / `cardBorder`).
 */

import { Card, type Component } from "@pit/tui";
import { theme } from "../theme/theme.ts";

export class SelectorCard implements Component {
	private card: Card;

	constructor(paddingX = 1, paddingY = 0, borderColor: (text: string) => string = (s) => theme.fg("cardBorder", s)) {
		this.card = new Card(paddingX, paddingY, (s) => theme.bg("cardBg", s), borderColor);
	}

	addChild(component: Component): void {
		this.card.addChild(component);
	}

	removeChild(component: Component): void {
		this.card.removeChild(component);
	}

	clear(): void {
		this.card.clear();
	}

	setPadding(paddingX: number, paddingY: number): void {
		this.card.setPadding(paddingX, paddingY);
	}

	setBorderColor(borderColor: (text: string) => string): void {
		this.card.setBorderColor(borderColor);
	}

	setBgFn(bgFn?: (text: string) => string): void {
		this.card.setBgFn(bgFn);
	}

	invalidate(): void {
		this.card.invalidate();
	}

	render(width: number): string[] {
		return this.card.render(width);
	}
}
