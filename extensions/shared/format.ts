const UNITS: ReadonlyArray<readonly [string, number]> = [
	["w", 604_800],
	["d", 86_400],
	["h", 3_600],
	["m", 60],
	["s", 1],
];

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const index = UNITS.findIndex(([, size]) => seconds >= size);
	const [unit, size] = UNITS[index] ?? ["s", 1];
	const next = UNITS[index + 1];
	if (index === -1 || !next) return `${seconds}s`;
	return `${Math.floor(seconds / size)}${unit} ${Math.floor((seconds % size) / next[1])}${next[0]}`;
}
