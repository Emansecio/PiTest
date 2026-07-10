import * as fs from "node:fs";
import { Container, Image, Spacer, Text } from "@pit/tui";
import { getBundledInteractiveAssetPath } from "../../../config.ts";
import { theme } from "../theme/theme.ts";
import { SelectorCard } from "./selector-card.ts";

const BLOG_URL = "https://pituned.at/posts/2026-04-08-ive-sold-out/";
const IMAGE_FILENAME = "clankolas.png";

let cachedImageBase64: string | undefined;
let attemptedImageLoad = false;

function loadImageBase64(): string | undefined {
	if (attemptedImageLoad) {
		return cachedImageBase64;
	}

	attemptedImageLoad = true;
	try {
		cachedImageBase64 = fs.readFileSync(getBundledInteractiveAssetPath(IMAGE_FILENAME)).toString("base64");
	} catch {
		cachedImageBase64 = undefined;
	}
	return cachedImageBase64;
}

export class EarendilAnnouncementComponent extends Container {
	constructor() {
		super();

		const card = new SelectorCard(1, 0, (text) => theme.fg("accent", text));
		card.addChild(new Text(theme.bold(theme.fg("accent", "pi has joined Earendil")), 1, 0));
		card.addChild(new Spacer(1));
		card.addChild(new Text(theme.fg("muted", "Read the blog post:"), 1, 0));
		card.addChild(new Text(theme.fg("mdLink", BLOG_URL), 1, 0));
		card.addChild(new Spacer(1));

		const imageBase64 = loadImageBase64();
		if (imageBase64) {
			card.addChild(
				new Image(
					imageBase64,
					"image/png",
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ maxWidthCells: 56, filename: IMAGE_FILENAME },
				),
			);
			card.addChild(new Spacer(1));
		}

		this.addChild(card);
	}
}
