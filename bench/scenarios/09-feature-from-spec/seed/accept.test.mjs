import { slugify } from "./cli.mjs";

function eq(got, want) {
	if (got !== want) {
		console.log(`FAIL: slugify -> expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
		process.exit(1);
	}
}

eq(slugify("  Hello, World!  "), "hello-world");
eq(slugify("Foo___Bar"), "foo-bar");
eq(slugify("a.b.c"), "a-b-c");
eq(slugify("MixOf CASE 123"), "mixof-case-123");
eq(slugify("--leading--"), "leading");
eq(slugify("multiple   spaces"), "multiple-spaces");
console.log("OK");
