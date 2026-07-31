/**
 * SettingsList mouse: a left press on a setting row selects and activates it
 * (cycle values / open submenu), rows that are not settings (headers, hint,
 * description, scroll info) are declined, and with a submenu open the event is
 * delegated to the submenu component untouched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.js";
import { type SettingItem, SettingsList } from "../src/components/settings-list.js";
import type { MouseEvent } from "../src/keys.js";

const testTheme = {
	label: (text: string) => text,
	value: (text: string) => text,
	description: (text: string) => text,
	cursor: "→ ",
	hint: (text: string) => text,
};

const selectTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

const leftPress = (overrides: Partial<MouseEvent> = {}): MouseEvent => ({
	type: "press",
	button: "left",
	wheel: undefined,
	x: 1,
	y: 1,
	shift: false,
	ctrl: false,
	alt: false,
	raw: "",
	...overrides,
});

function makeItems(): SettingItem[] {
	return [
		{ id: "alpha", label: "Alpha", group: "General", currentValue: "on", values: ["on", "off"] },
		{ id: "beta", label: "Beta", group: "General", currentValue: "1", values: ["1", "2", "3"] },
	];
}

describe("SettingsList mouse", () => {
	it("clicking a setting row selects it and cycles its value", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			makeItems(),
			5,
			testTheme,
			(id, value) => changes.push([id, value]),
			() => {},
		);
		const rendered = list.render(80);

		// Row 0 is the "General" group header; rows 1-2 are the settings.
		assert.ok(rendered[0]?.includes("General"));
		assert.equal(list.onMouse(leftPress(), 2, 4), true);
		assert.deepEqual(changes, [["beta", "2"]]);
	});

	it("declines clicks on the group header and the hint rows", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			makeItems(),
			5,
			testTheme,
			(id, value) => changes.push([id, value]),
			() => {},
		);
		const rendered = list.render(80);

		assert.equal(list.onMouse(leftPress(), 0, 4), false); // header
		assert.equal(list.onMouse(leftPress(), rendered.length - 1, 4), false); // hint line
		assert.deepEqual(changes, []);
	});

	it("clicking a submenu-backed row opens the submenu; the next click is delegated to it", () => {
		const changes: Array<[string, string]> = [];
		const submenuList = new SelectList(
			[
				{ value: "dark", label: "dark" },
				{ value: "light", label: "light" },
			],
			5,
			selectTheme,
		);
		const items: SettingItem[] = [
			{
				id: "theme",
				label: "Theme",
				currentValue: "dark",
				submenu: (_current, done) => {
					submenuList.onSelect = (item) => done(item.value);
					return submenuList;
				},
			},
		];
		const list = new SettingsList(
			items,
			5,
			testTheme,
			(id, value) => changes.push([id, value]),
			() => {},
		);
		list.render(80);

		// Click the "Theme" row (no group → row 0 is the setting itself).
		assert.equal(list.onMouse(leftPress(), 0, 4), true);
		list.render(80); // submenu rows now own the frame

		// Click "light" inside the submenu → delegated, selects, and closes via done().
		assert.equal(list.onMouse(leftPress(), 1, 4), true);
		assert.deepEqual(changes, [["theme", "light"]]);
	});

	it("declines drags, releases and right presses", () => {
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			makeItems(),
			5,
			testTheme,
			(id, value) => changes.push([id, value]),
			() => {},
		);
		list.render(80);

		assert.equal(list.onMouse(leftPress({ type: "release" }), 1, 4), false);
		assert.equal(list.onMouse(leftPress({ type: "drag" }), 1, 4), false);
		assert.equal(list.onMouse(leftPress({ button: "right" }), 1, 4), false);
		assert.deepEqual(changes, []);
	});
});
