# slugify

Implement `slugify(input)` exported from `cli.mjs`. Given a string, it returns a
URL-friendly slug by applying these rules **in order**:

1. Lowercase the whole string.
2. Trim leading and trailing whitespace.
3. Replace every run of one or more characters that are **not** `a-z` or `0-9`
   with a single hyphen `-`.
4. Remove any leading or trailing hyphens from the result.

Examples:

| input | output |
|-|-|
| `"  Hello, World!  "` | `"hello-world"` |
| `"Foo___Bar"` | `"foo-bar"` |
| `"a.b.c"` | `"a-b-c"` |
| `"MixOf CASE 123"` | `"mixof-case-123"` |
| `"--leading--"` | `"leading"` |
| `"multiple   spaces"` | `"multiple-spaces"` |
