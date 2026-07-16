function titleWords(value: string): string {
	return value
		.split("-")
		.filter(Boolean)
		.map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
		.join(" ");
}

/** Convert provider-facing model ids into compact labels for the composer only. */
export function formatModelDisplayName(modelId: string): string {
	const base = modelId.trim().split(/[/:]/).at(-1) || "no-model";

	const claude = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i.exec(base);
	if (claude) {
		const family = titleWords(claude[1] ?? "");
		const version = claude[3] ? `${claude[2]}.${claude[3]}` : claude[2];
		return `${family} ${version}`;
	}

	const gpt = /^gpt-(\d+(?:[.-]\d+)*)(?:-(.+))?$/i.exec(base);
	if (gpt) {
		const version = (gpt[1] ?? "").replaceAll("-", ".");
		const variant = gpt[2] ? ` ${titleWords(gpt[2])}` : "";
		return `GPT-${version}${variant}`;
	}

	return base;
}
