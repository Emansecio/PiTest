# Tool-calling regression suite

Scenarios that exercise the harness's defenses against incorrect tool calls
end-to-end through the faux provider. Each test models a specific LLM mistake
we have seen in production traces and asserts that the harness either:

- normalizes the call into a valid one (alias / JSON-string / indent fuzz),
- or returns an actionable error the model can recover from in one round trip
  (near-miss hint, "did you mean").

Add a new scenario as a numbered `.test.ts` file when you observe a new class
of failure. Keep one observed-failure-class per test for easy bisection.
