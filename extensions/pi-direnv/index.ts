import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function direnv(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		let result: Awaited<ReturnType<typeof pi.exec>>;
		try {
			result = await pi.exec("direnv", ["export", "json"], { cwd: ctx.cwd });
		} catch {
			return;
		}

		if (result.code !== 0) {
			if (result.stderr.includes("is blocked")) {
				ctx.ui.notify(".envrc is blocked. Run `direnv allow` to enable it.", "warning");
			}
			return;
		}

		try {
			const env = JSON.parse(result.stdout) as Record<string, string | null>;
			for (const [name, value] of Object.entries(env)) {
				if (value === null) delete process.env[name];
				else process.env[name] = value;
			}
		} catch {}
	});
}
