import assert from "node:assert";
import { describe, it } from "node:test";
import { Input } from "../src/components/input.js";
import { visibleWidth } from "../src/utils.js";

describe("Input component", () => {
	describe("placeholder", () => {
		it("shows placeholder text when the input is empty", () => {
			const input = new Input({
				placeholder: "e.g., sk-…",
				placeholderColor: (s) => `<PH>${s}</PH>`,
			});
			input.focused = true;
			const [line] = input.render(40);
			// Strip SGR + OSC cursor marker; full placeholder is colorized (cursor is space).
			const plain = (line ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
			assert.ok(plain.includes("e.g., sk-…"), `expected placeholder, got: ${JSON.stringify(plain)}`);
			assert.ok(line?.includes("<PH>"), "placeholder should be colorized");
		});

		it("clears the placeholder when the user types", () => {
			const input = new Input({ placeholder: "e.g., sk-…" });
			input.handleInput("a");
			const [line] = input.render(40);
			const plain = line?.replace(/\x1b\[[0-9;]*m/g, "") ?? "";
			assert.ok(!plain.includes("e.g., sk-…"), "placeholder must disappear after typing");
		});
	});

	it("submits value including backslash on Enter", () => {
		const input = new Input();
		let submitted: string | undefined;

		input.onSubmit = (value) => {
			submitted = value;
		};

		// Type hello, then backslash, then Enter
		input.handleInput("h");
		input.handleInput("e");
		input.handleInput("l");
		input.handleInput("l");
		input.handleInput("o");
		input.handleInput("\\");
		input.handleInput("\r");

		// Input is single-line, no backslash+Enter workaround
		assert.strictEqual(submitted, "hello\\");
	});

	it("inserts backslash as regular character", () => {
		const input = new Input();

		input.handleInput("\\");
		input.handleInput("x");

		assert.strictEqual(input.getValue(), "\\x");
	});

	describe("render", () => {
		it("does not overflow with wide CJK and fullwidth text", () => {
			const width = 93;
			const cases = [
				"가나다라마바사아자차카타파하 한글 텍스트가 터미널 너비를 초과하면 크래시가 발생합니다 이것은 재현용 테스트입니다",
				"これはテスト文章です。日本語のテキストが正しく表示されるかどうかを確認するためのサンプルテキストです。あいうえお",
				"这是一段测试文本，用于验证中文字符在终端中的显示宽度是否被正确计算，如果不正确就会导致用户界面崩溃的问题",
				"ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ０１２３４５６７８９ａｂｃｄｅｆｇｈｉｊｋｌｍ",
			];
			const cursorPositions = [
				{ label: "start", move: (_input: Input) => {} },
				{
					label: "middle",
					move: (input: Input) => {
						for (let i = 0; i < 10; i++) input.handleInput("\x1b[C");
					},
				},
				{ label: "end", move: (input: Input) => input.handleInput("\x05") },
			];

			for (const text of cases) {
				for (const { label, move } of cursorPositions) {
					const input = new Input();
					input.setValue(text);
					input.focused = true;
					move(input);

					const [line] = input.render(width);
					assert.ok(line);
					assert.ok(visibleWidth(line) <= width, `rendered line overflowed for ${text} at ${label}`);
				}
			}
		});

		it("keeps the cursor visible when horizontally scrolling wide text", () => {
			const input = new Input();
			const width = 20;
			const text = "가나다라마바사아자차카타파하";
			input.setValue(text);
			input.focused = true;
			input.handleInput("\x01");
			for (let i = 0; i < 5; i++) input.handleInput("\x1b[C");

			const [line] = input.render(width);
			assert.ok(line);
			assert.ok(visibleWidth(line) <= width);
		});
	});

	describe("Kill ring", () => {
		it("Ctrl+W saves deleted text to kill ring and Ctrl+Y yanks it", () => {
			const input = new Input();

			input.setValue("foo bar baz");
			// Move cursor to end
			input.handleInput("\x05"); // Ctrl+E

			input.handleInput("\x17"); // Ctrl+W - deletes "baz"
			assert.strictEqual(input.getValue(), "foo bar ");

			// Move to beginning and yank
			input.handleInput("\x01"); // Ctrl+A
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "bazfoo bar ");
		});

		it("Ctrl+U saves deleted text to kill ring", () => {
			const input = new Input();

			input.setValue("hello world");
			// Move cursor to after "hello "
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x15"); // Ctrl+U - deletes "hello "
			assert.strictEqual(input.getValue(), "world");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("Ctrl+K saves deleted text to kill ring", () => {
			const input = new Input();

			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A
			input.handleInput("\x0b"); // Ctrl+K - deletes "hello world"

			assert.strictEqual(input.getValue(), "");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("Ctrl+Y does nothing when kill ring is empty", () => {
			const input = new Input();

			input.setValue("test");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "test");
		});

		it("Alt+Y cycles through kill ring after Ctrl+Y", () => {
			const input = new Input();

			// Create kill ring with multiple entries
			input.setValue("first");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "first"
			input.setValue("second");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "second"
			input.setValue("third");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "third"

			assert.strictEqual(input.getValue(), "");

			input.handleInput("\x19"); // Ctrl+Y - yanks "third"
			assert.strictEqual(input.getValue(), "third");

			input.handleInput("\x1by"); // Alt+Y - cycles to "second"
			assert.strictEqual(input.getValue(), "second");

			input.handleInput("\x1by"); // Alt+Y - cycles to "first"
			assert.strictEqual(input.getValue(), "first");

			input.handleInput("\x1by"); // Alt+Y - cycles back to "third"
			assert.strictEqual(input.getValue(), "third");
		});

		it("Alt+Y does nothing if not preceded by yank", () => {
			const input = new Input();

			input.setValue("test");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "test"
			input.setValue("other");
			input.handleInput("\x05"); // Ctrl+E

			// Type something to break the yank chain
			input.handleInput("x");
			assert.strictEqual(input.getValue(), "otherx");

			input.handleInput("\x1by"); // Alt+Y - should do nothing
			assert.strictEqual(input.getValue(), "otherx");
		});

		it("Alt+Y does nothing if kill ring has one entry", () => {
			const input = new Input();

			input.setValue("only");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "only"

			input.handleInput("\x19"); // Ctrl+Y - yanks "only"
			assert.strictEqual(input.getValue(), "only");

			input.handleInput("\x1by"); // Alt+Y - should do nothing
			assert.strictEqual(input.getValue(), "only");
		});

		it("consecutive Ctrl+W accumulates into one kill ring entry", () => {
			const input = new Input();

			input.setValue("one two three");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "three"
			input.handleInput("\x17"); // Ctrl+W - deletes "two "
			input.handleInput("\x17"); // Ctrl+W - deletes "one "

			assert.strictEqual(input.getValue(), "");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "one two three");
		});

		it("non-delete actions break kill accumulation", () => {
			const input = new Input();

			input.setValue("foo bar baz");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "baz"
			assert.strictEqual(input.getValue(), "foo bar ");

			input.handleInput("x"); // Typing breaks accumulation
			assert.strictEqual(input.getValue(), "foo bar x");

			input.handleInput("\x17"); // Ctrl+W - deletes "x" (separate entry)
			assert.strictEqual(input.getValue(), "foo bar ");

			input.handleInput("\x19"); // Ctrl+Y - most recent is "x"
			assert.strictEqual(input.getValue(), "foo bar x");

			input.handleInput("\x1by"); // Alt+Y - cycle to "baz"
			assert.strictEqual(input.getValue(), "foo bar baz");
		});

		it("non-yank actions break Alt+Y chain", () => {
			const input = new Input();

			input.setValue("first");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W
			input.setValue("second");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W
			input.setValue("");

			input.handleInput("\x19"); // Ctrl+Y - yanks "second"
			assert.strictEqual(input.getValue(), "second");

			input.handleInput("x"); // Breaks yank chain
			assert.strictEqual(input.getValue(), "secondx");

			input.handleInput("\x1by"); // Alt+Y - should do nothing
			assert.strictEqual(input.getValue(), "secondx");
		});

		it("kill ring rotation persists after cycling", () => {
			const input = new Input();

			input.setValue("first");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // deletes "first"
			input.setValue("second");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // deletes "second"
			input.setValue("third");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // deletes "third"
			input.setValue("");

			input.handleInput("\x19"); // Ctrl+Y - yanks "third"
			input.handleInput("\x1by"); // Alt+Y - cycles to "second"
			assert.strictEqual(input.getValue(), "second");

			// Break chain and start fresh
			input.handleInput("x");
			input.setValue("");

			// New yank should get "second" (now at end after rotation)
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "second");
		});

		it("backward deletions prepend, forward deletions append during accumulation", () => {
			const input = new Input();

			input.setValue("prefix|suffix");
			// Position cursor at "|"
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C"); // Move right 6

			input.handleInput("\x0b"); // Ctrl+K - deletes "|suffix" (forward)
			assert.strictEqual(input.getValue(), "prefix");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "prefix|suffix");
		});

		it("Alt+D deletes word forward and saves to kill ring", () => {
			const input = new Input();

			input.setValue("hello world test");
			input.handleInput("\x01"); // Ctrl+A

			input.handleInput("\x1bd"); // Alt+D - deletes "hello"
			assert.strictEqual(input.getValue(), " world test");

			input.handleInput("\x1bd"); // Alt+D - deletes " world"
			assert.strictEqual(input.getValue(), " test");

			// Yank should get accumulated text
			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello world test");
		});

		it("handles yank in middle of text", () => {
			const input = new Input();

			input.setValue("word");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "word"
			input.setValue("hello world");
			// Move to middle (after "hello ")
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x19"); // Ctrl+Y
			assert.strictEqual(input.getValue(), "hello wordworld");
		});

		it("handles yank-pop in middle of text", () => {
			const input = new Input();

			// Create two kill ring entries
			input.setValue("FIRST");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "FIRST"
			input.setValue("SECOND");
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("\x17"); // Ctrl+W - deletes "SECOND"

			// Set up "hello world" and position cursor after "hello "
			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x19"); // Ctrl+Y - yanks "SECOND"
			assert.strictEqual(input.getValue(), "hello SECONDworld");

			input.handleInput("\x1by"); // Alt+Y - replaces with "FIRST"
			assert.strictEqual(input.getValue(), "hello FIRSTworld");
		});
	});

	describe("Undo", () => {
		it("does nothing when undo stack is empty", () => {
			const input = new Input();

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "");
		});

		it("coalesces consecutive word characters into one undo unit", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			assert.strictEqual(input.getValue(), "hello world");

			// Undo removes " world"
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello");

			// Undo removes "hello"
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "");
		});

		it("undoes spaces one at a time", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput(" ");
			assert.strictEqual(input.getValue(), "hello  ");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes second " "
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes first " "
			assert.strictEqual(input.getValue(), "hello");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo) - removes "hello"
			assert.strictEqual(input.getValue(), "");
		});

		it("undoes backspace", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput("\x7f"); // Backspace
			assert.strictEqual(input.getValue(), "hell");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello");
		});

		it("undoes forward delete", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput("\x01"); // Ctrl+A - go to start
			input.handleInput("\x1b[C"); // Right arrow
			input.handleInput("\x1b[3~"); // Delete key
			assert.strictEqual(input.getValue(), "hllo");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello");
		});

		it("undoes Ctrl+W (delete word backward)", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			assert.strictEqual(input.getValue(), "hello world");

			input.handleInput("\x17"); // Ctrl+W
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes Ctrl+K (delete to line end)", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x0b"); // Ctrl+K
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes Ctrl+U (delete to line start)", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("w");
			input.handleInput("o");
			input.handleInput("r");
			input.handleInput("l");
			input.handleInput("d");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");

			input.handleInput("\x15"); // Ctrl+U
			assert.strictEqual(input.getValue(), "world");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes yank", () => {
			const input = new Input();

			input.handleInput("h");
			input.handleInput("e");
			input.handleInput("l");
			input.handleInput("l");
			input.handleInput("o");
			input.handleInput(" ");
			input.handleInput("\x17"); // Ctrl+W - delete "hello "
			input.handleInput("\x19"); // Ctrl+Y - yank
			assert.strictEqual(input.getValue(), "hello ");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "");
		});

		it("undoes paste atomically", () => {
			const input = new Input();

			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A
			for (let i = 0; i < 5; i++) input.handleInput("\x1b[C");

			// Simulate bracketed paste
			input.handleInput("\x1b[200~beep boop\x1b[201~");
			assert.strictEqual(input.getValue(), "hellobeep boop world");

			// Single undo should restore entire pre-paste state
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("undoes Alt+D (delete word forward)", () => {
			const input = new Input();

			input.setValue("hello world");
			input.handleInput("\x01"); // Ctrl+A

			input.handleInput("\x1bd"); // Alt+D - deletes "hello"
			assert.strictEqual(input.getValue(), " world");

			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("cursor movement starts new undo unit", () => {
			const input = new Input();

			input.handleInput("a");
			input.handleInput("b");
			input.handleInput("c");
			input.handleInput("\x01"); // Ctrl+A - movement breaks coalescing
			input.handleInput("\x05"); // Ctrl+E
			input.handleInput("d");
			input.handleInput("e");
			assert.strictEqual(input.getValue(), "abcde");

			// Undo removes "de" (typed after movement)
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "abc");

			// Undo removes "abc"
			input.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
			assert.strictEqual(input.getValue(), "");
		});
	});

	describe("Paste control-char filter and size cap", () => {
		// Old per-char filter the regex replaces (tabs expanded first); equivalence oracle.
		const legacyInputFilter = (s: string): string =>
			s
				.replace(/\t/g, "    ")
				.split("")
				.filter((char) => char.charCodeAt(0) >= 32)
				.join("");
		// Mirror of MAX_PASTE_BYTES in input.ts (constant is module-private).
		const MAX_PASTE_BYTES = 10 * 1024 * 1024;

		it("regex strips the exact same chars as the old split/filter/join", () => {
			const samples: string[] = ["line1\nline2\r\nline3\tend", "tab\tsep", "emoji 😀 zwj 👨‍👩‍👧 mix", "café ñ 漢字"];
			for (let i = 0; i <= 0x1f; i++) samples.push(`a${String.fromCharCode(i)}b`);
			samples.push(`pre\x7fpost`);
			samples.push("\x00\x09\x0a\x0d\x1f\x20\x7e\x7f end");

			for (const sample of samples) {
				const viaRegex = sample.replace(/\t/g, "    ").replace(/[\x00-\x1f]/g, "");
				assert.deepStrictEqual(viaRegex, legacyInputFilter(sample), `mismatch for ${JSON.stringify(sample)}`);
			}
		});

		it("inserts a small paste, stripping newlines and expanding tabs", () => {
			const input = new Input();
			input.handleInput("\x1b[200~a\tb\nc\x1b[201~");
			// tab -> 4 spaces, newline stripped
			assert.strictEqual(input.getValue(), "a    bc");
		});

		it("caps an oversized paste so the value never exceeds MAX_PASTE_BYTES", () => {
			const input = new Input();
			const huge = "a".repeat(12 * 1024 * 1024); // 12 MiB
			const start = Date.now();
			input.handleInput(`\x1b[200~${huge}\x1b[201~`);
			const elapsed = Date.now() - start;

			assert.ok(input.getValue().length <= MAX_PASTE_BYTES, `value length ${input.getValue().length} > cap`);
			assert.strictEqual(input.getValue().length, MAX_PASTE_BYTES, "oversized paste should be truncated to the cap");
			assert.ok(elapsed < 4000, `paste handling took ${elapsed}ms`);
		});

		it("fires onPasteTruncated with original/kept bytes when a paste is truncated", () => {
			const calls: Array<{ originalBytes: number; keptBytes: number }> = [];
			const input = new Input({ onPasteTruncated: (info) => calls.push(info) });
			const originalLen = 12 * 1024 * 1024;
			input.handleInput(`\x1b[200~${"a".repeat(originalLen)}\x1b[201~`);

			assert.strictEqual(calls.length, 1, "callback should fire exactly once");
			assert.strictEqual(calls[0]!.originalBytes, originalLen, "originalBytes is the pre-truncation length");
			assert.strictEqual(calls[0]!.keptBytes, MAX_PASTE_BYTES, "keptBytes is the cap");
			assert.strictEqual(input.getValue().length, MAX_PASTE_BYTES, "value truncated to the cap");
		});

		it("does not fire onPasteTruncated for a normal (sub-cap) paste", () => {
			const calls: Array<{ originalBytes: number; keptBytes: number }> = [];
			const input = new Input({ onPasteTruncated: (info) => calls.push(info) });
			input.handleInput("\x1b[200~hello world\x1b[201~");
			assert.strictEqual(calls.length, 0, "no truncation => no callback");
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("handles the bracketed-paste end marker split across two chunks", () => {
			const input = new Input();
			input.handleInput("\x1b[200~hello world");
			// "\x1b[201~" (6 chars) delivered as two separate handleInput chunks.
			input.handleInput("\x1b[20");
			input.handleInput("1~");
			assert.strictEqual(input.getValue(), "hello world");
		});

		it("reconstructs a paste fed as many small, arbitrarily-split chunks (windowed end-marker search)", () => {
			const input = new Input();
			input.handleInput("\x1b[200~");
			const payload = "abcdefghij".repeat(2000); // 20,000 chars
			let offset = 0;
			while (offset < payload.length) {
				const chunkLen = 1 + (offset % 7); // 1..7 chars per chunk, uneven on purpose
				input.handleInput(payload.slice(offset, offset + chunkLen));
				offset += chunkLen;
			}
			// Split the end marker itself across two more chunks.
			input.handleInput("\x1b[20");
			input.handleInput("1~");
			assert.strictEqual(input.getValue(), payload);
		});
	});
});
