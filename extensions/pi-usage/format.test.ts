import assert from "node:assert/strict";
import { test } from "node:test";
import { formatReport } from "./format.ts";

const fg = (_color: string, text: string) => text;

test("formatReport shows provider and limit bars", () => {
	const lines = formatReport(
		{
			provider: "anthropic",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "5h",
					label: "5h",
					status: "ok",
					amount: { unit: "usd", used: 1.5, limit: 5 },
					window: { id: "5h", label: "5h", resetsAt: Date.now() + 60_000 },
				},
			],
			metadata: { endpoint: "api.anthropic.com", planType: "pro" },
		},
		fg,
	);
	assert.ok(lines[0] === "anthropic");
	assert.match(lines[1] ?? "", /5h/);
	assert.match(lines.join("\n"), /api\.anthropic\.com/);
});

test("formatReport handles empty limits", () => {
	const lines = formatReport({ provider: "xai", fetchedAt: Date.now(), limits: [] }, fg);
	assert.ok(lines.includes("  No usage limits reported."));
});
