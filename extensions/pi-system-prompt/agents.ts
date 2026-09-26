import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const AGENT_RULES_PATH = fileURLToPath(new URL("./SYSTEM.txt", import.meta.url));

export function loadAgentRules(): string {
	return readFileSync(AGENT_RULES_PATH, "utf-8").trim();
}
