import { complete, createAssistantMessageEventStream, getModel, getProviders, Type } from "@pit/ai";
import { Agent, streamProxy, uuidv7 } from "@pit/agent-core";

// Keep this entry browser-safe. It is bundled by scripts/check-browser-smoke.mjs
// to catch accidental Node-only runtime imports in browser-facing package exports.
const model = getModel("google", "gemini-2.5-flash");
const schema = Type.Object({ prompt: Type.String() });
const stream = createAssistantMessageEventStream();

const agent = new Agent({ initialState: { model } });
agent.steer({ role: "user", content: [{ type: "text", text: "queued" }], timestamp: 0 });

console.log(
	model.id,
	getProviders().length,
	typeof complete,
	schema.type,
	typeof stream.push,
	agent.hasQueuedMessages(),
	typeof streamProxy,
	uuidv7().length,
);
