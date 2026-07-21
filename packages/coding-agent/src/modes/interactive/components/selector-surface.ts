/**
 * Shared mount helper for in-composer selectors: when `embedded` (default),
 * children attach directly to the host so ComposerChrome supplies the only frame.
 * Otherwise wrap in {@link SelectorCard} with the usual outer spacer.
 */

import { type Component, type Container, Spacer } from "@pit/tui";
import { SelectorCard } from "./selector-card.ts";

export type SelectorSurface = {
	addChild(component: Component): void;
};

export function beginSelectorSurface(host: Container, embedded = true): { surface: SelectorSurface; mount(): void } {
	if (embedded) {
		return { surface: host, mount: () => {} };
	}
	const card = new SelectorCard();
	return {
		surface: card,
		mount: () => {
			host.addChild(new Spacer(1));
			host.addChild(card);
		},
	};
}
