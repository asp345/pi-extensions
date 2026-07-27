import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { fetchRemote, validateRemoteUrl } from "./security.ts";
import { geminiAvailable, geminiGenerate, geminiUploadVideo } from "./search.ts";
import { storedText, type FetchedContent } from "./storage.ts";

const HTML_BYTES = 5 * 1024 * 1024;
const PDF_BYTES = 20 * 1024 * 1024;
const VIDEO_BYTES = 50 * 1024 * 1024;
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export interface MediaImage {
	data: string;
	mimeType: string;
	label?: string;
}
export interface ExtractedContent extends FetchedContent {
	images?: MediaImage[];
	duration?: number;
}
export interface ExtractOptions {
	question?: string;
	timestamp?: string;
	frames?: number;
}

export async function extractAll(
	urls: string[],
	options: ExtractOptions,
	signal?: AbortSignal,
): Promise<ExtractedContent[]> {
	const output = new Array<ExtractedContent>(urls.length);
	let next = 0;
	async function worker() {
		while (next < urls.length) {
			const index = next++;
			output[index] = await extractOne(urls[index], options, signal).catch((error) => failure(urls[index], error));
		}
	}
	await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker));
	return output;
}

export async function extractOne(
	input: string,
	options: ExtractOptions = {},
	signal?: AbortSignal,
): Promise<ExtractedContent> {
	if (signal?.aborted) throw new Error("Aborted");
	const local = await localVideo(input);
	if (local) return extractLocalVideo(local.path, local.mimeType, options, signal);

	let url: URL;
	try {
		url = await validateRemoteUrl(input);
	} catch (error) {
		return failure(input, error);
	}
	const youtube = youtubeId(url);
	if (youtube) return extractYouTube(url.toString(), youtube, options, signal);
	const github = parseGitHub(url);
	if (github) {
		const result = await extractGitHub(url.toString(), github, signal);
		if (result) return result;
	}
	return extractHttp(url.toString(), signal);
}

async function extractHttp(url: string, signal?: AbortSignal): Promise<ExtractedContent> {
	try {
		const response = await fetchRemote(url, {
			headers: {
				"user-agent": "Mozilla/5.0 (compatible; pi-web-access/1.0)",
				accept:
					"text/html,application/xhtml+xml,application/pdf,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5",
			},
			signal: combinedSignal(signal, 30_000),
		});
		if (!response.ok) return failure(url, `HTTP ${response.status}: ${response.statusText}`);
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		const pdf = contentType.includes("application/pdf") || new URL(url).pathname.toLowerCase().endsWith(".pdf");
		if (pdf) {
			const bytes = await readBytes(response, PDF_BYTES);
			const extracted = await extractPdf(bytes, url);
			return bounded({ url, title: extracted.title, content: extracted.content });
		}
		if (/^(image|audio|video)\//.test(contentType) || /application\/(zip|octet-stream)/.test(contentType)) {
			return failure(url, `Unsupported content type: ${contentType.split(";")[0]}`);
		}
		const text = new TextDecoder().decode(await readBytes(response, HTML_BYTES));
		if (!contentType.includes("html") && !/^\s*<!doctype html|^\s*<html/i.test(text)) {
			return bounded({ url, title: textTitle(text, url), content: text });
		}
		const { document } = parseHTML(text);
		const article = new Readability(document as unknown as Document).parse();
		if (article?.content) {
			const markdown = turndown.turndown(article.content).trim();
			if (markdown) return bounded({ url, title: article.title || textTitle(markdown, url), content: markdown });
		}
		const fallback =
			document.body?.textContent
				?.replace(/\s*\n\s*/g, "\n")
				.replace(/[ \t]+/g, " ")
				.trim() ?? "";
		if (fallback.length < 100) return failure(url, "Could not extract readable HTML content");
		return bounded({ url, title: document.title || textTitle(fallback, url), content: fallback });
	} catch (error) {
		if (signal?.aborted) throw new Error("Aborted");
		return failure(url, error);
	}
}

async function extractPdf(bytes: Uint8Array, url: string): Promise<{ title: string; content: string }> {
	const { getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(bytes, { verbosity: 0 });
	const metadata = await pdf.getMetadata();
	const info = metadata.info && typeof metadata.info === "object" ? (metadata.info as Record<string, unknown>) : {};
	const title =
		typeof info.Title === "string" && info.Title.trim()
			? info.Title.trim()
			: basename(new URL(url).pathname, ".pdf") || "document";
	const lines = [`# ${title}`, "", `Source: ${url}`, `Pages: ${pdf.numPages}`, ""];
	const pages = Math.min(pdf.numPages, 100);
	for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
		const page = await pdf.getPage(pageNumber);
		const content = await page.getTextContent();
		const text = content.items
			.map((item: { str?: unknown }) => (typeof item.str === "string" ? item.str : ""))
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (text) lines.push(`## Page ${pageNumber}`, "", text, "");
	}
	if (pages < pdf.numPages) lines.push(`[Only the first ${pages} pages were extracted.]`);
	return { title, content: lines.join("\n") };
}

interface GitHubInfo {
	owner: string;
	repo: string;
	kind: "root" | "tree" | "blob";
	ref?: string;
	path?: string;
}
function parseGitHub(url: URL): GitHubInfo | undefined {
	if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
	const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
	if (parts.length < 2 || ["issues", "pull", "pulls", "releases", "discussions"].includes(parts[2])) return undefined;
	const base = { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
	if (parts[2] === "blob" || parts[2] === "tree")
		return { ...base, kind: parts[2], ref: parts[3], path: parts.slice(4).join("/") };
	if (parts.length === 2) return { ...base, kind: "root" };
	return undefined;
}

async function extractGitHub(
	url: string,
	info: GitHubInfo,
	signal?: AbortSignal,
): Promise<ExtractedContent | undefined> {
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "pi-web-access" };
	if (token) headers.authorization = `Bearer ${token}`;
	const api = async (path: string) => {
		const response = await fetchRemote(`https://api.github.com${path}`, {
			headers,
			signal: combinedSignal(signal, 30_000),
		});
		if (!response.ok) throw new Error(`GitHub API error ${response.status}`);
		return JSON.parse(new TextDecoder().decode(await readBytes(response, 5 * 1024 * 1024)));
	};
	try {
		const repo = await api(`/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}`);
		const ref = info.ref || repo.default_branch;
		if (!ref) throw new Error("GitHub repository has no default branch");
		if (info.kind === "blob" && info.path) {
			const file = await api(
				`/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/contents/${encodePath(info.path)}?ref=${encodeURIComponent(ref)}`,
			);
			if (file.type !== "file" || typeof file.content !== "string") throw new Error("GitHub path is not a file");
			const content = Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
			return bounded({
				url,
				title: `${info.owner}/${info.repo} - ${info.path}`,
				content: `# ${info.path}\n\n${content}`,
			});
		}
		const tree = await api(
			`/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
		);
		let paths: string[] = (Array.isArray(tree.tree) ? tree.tree : [])
			.map((entry: unknown) => (entry && typeof entry === "object" && "path" in entry ? entry.path : undefined))
			.filter((path: unknown): path is string => typeof path === "string");
		if (info.kind === "tree" && info.path)
			paths = paths.filter((path) => path === info.path || path.startsWith(`${info.path}/`));
		const shown = paths.slice(0, 400);
		let readme = "";
		if (info.kind === "root") {
			try {
				const data = await api(
					`/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/readme?ref=${encodeURIComponent(ref)}`,
				);
				if (typeof data.content === "string")
					readme = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8").slice(0, 30_000);
			} catch {}
		}
		const content = [
			`# ${info.owner}/${info.repo}`,
			"",
			`Branch: ${ref}`,
			"",
			"## Files",
			...shown.map((path) => `- ${path}`),
		];
		if (shown.length < paths.length) content.push(`- ... ${paths.length - shown.length} more files`);
		if (readme) content.push("", "## README", "", readme);
		return bounded({
			url,
			title: `${info.owner}/${info.repo}${info.path ? ` - ${info.path}` : ""}`,
			content: content.join("\n"),
		});
	} catch {
		return undefined;
	}
}

async function extractYouTube(
	url: string,
	videoId: string,
	options: ExtractOptions,
	signal?: AbortSignal,
): Promise<ExtractedContent> {
	if (options.timestamp || options.frames) return youtubeFrames(url, videoId, options, signal);
	const question =
		options.question?.trim() ||
		"Provide the video title, summary, and a detailed timestamped transcript. Describe important visuals. Format as markdown.";
	let apiError = "";
	if (geminiAvailable()) {
		try {
			const content = await geminiGenerate(
				[{ fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` } }, { text: question }],
				{ signal, timeoutMs: 120_000 },
			);
			return bounded({ url, title: heading(content) || "YouTube video", content });
		} catch (error) {
			apiError = errorMessage(error);
		}
	}
	try {
		const transcript = await youtubeTranscript(videoId, signal);
		return bounded({
			url,
			title: transcript.title || "YouTube video",
			content: transcript.content,
			duration: transcript.duration,
		});
	} catch (error) {
		return failure(url, [apiError, errorMessage(error)].filter(Boolean).join("; ") || "YouTube extraction failed");
	}
}

async function youtubeTranscript(
	videoId: string,
	signal?: AbortSignal,
): Promise<{ title: string; content: string; duration?: number }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-youtube-"));
	try {
		const target = `https://www.youtube.com/watch?v=${videoId}`;
		const metadata = await run(
			"yt-dlp",
			["--skip-download", "--print", "title", "--print", "duration", target],
			signal,
			30_000,
		);
		await run(
			"yt-dlp",
			[
				"--skip-download",
				"--write-subs",
				"--write-auto-subs",
				"--sub-langs",
				"en.*,en",
				"--sub-format",
				"vtt",
				"-o",
				join(dir, "video.%(ext)s"),
				target,
			],
			signal,
			60_000,
		);
		const file = (await readdir(dir)).find((name) => name.endsWith(".vtt"));
		if (!file) throw new Error("No English subtitles are available");
		const vtt = await readFile(join(dir, file), "utf8");
		const [title = "YouTube video", rawDuration] = metadata.trim().split("\n");
		const duration = Number(rawDuration);
		return {
			title,
			content: `# ${title}\n\n${vttToMarkdown(vtt)}`,
			...(Number.isFinite(duration) ? { duration } : {}),
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function youtubeFrames(
	url: string,
	videoId: string,
	options: ExtractOptions,
	signal?: AbortSignal,
): Promise<ExtractedContent> {
	try {
		const target = `https://www.youtube.com/watch?v=${videoId}`;
		const output = await run(
			"yt-dlp",
			["--print", "duration", "-g", "-f", "best[height<=720]/best", target],
			signal,
			30_000,
		);
		const lines = output.trim().split("\n");
		const duration = Number(lines[0]);
		const stream = lines[1];
		if (!stream) throw new Error("yt-dlp returned no video stream");
		const timestamps = frameTimes(options.timestamp, options.frames, Number.isFinite(duration) ? duration : undefined);
		const images = await Promise.all(
			timestamps.map(async (seconds) => ({
				...(await ffmpegFrame(stream, seconds, signal)),
				label: formatTime(seconds),
			})),
		);
		return {
			url,
			title: `YouTube frames (${images.length})`,
			content: `Extracted frames at ${timestamps.map(formatTime).join(", ")}.`,
			images,
			...(Number.isFinite(duration) ? { duration } : {}),
		};
	} catch (error) {
		return failure(url, error);
	}
}

async function localVideo(input: string): Promise<{ path: string; mimeType: string } | undefined> {
	let path = input;
	if (input.startsWith("file://")) {
		try {
			path = fileURLToPath(input);
		} catch {
			return undefined;
		}
	} else if (!input.startsWith("/") && !input.startsWith("./") && !input.startsWith("../")) return undefined;
	const absolute = resolve(path);
	const mime = videoMime(extname(absolute));
	if (!mime) return undefined;
	try {
		return (await stat(absolute)).isFile() ? { path: absolute, mimeType: mime } : undefined;
	} catch {
		return undefined;
	}
}

async function extractLocalVideo(
	path: string,
	mimeType: string,
	options: ExtractOptions,
	signal?: AbortSignal,
): Promise<ExtractedContent> {
	if (options.timestamp || options.frames) {
		const durationText = await run(
			"ffprobe",
			["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", path],
			signal,
			15_000,
		);
		const duration = Number(durationText.trim());
		const timestamps = frameTimes(options.timestamp, options.frames, Number.isFinite(duration) ? duration : undefined);
		const images = await Promise.all(
			timestamps.map(async (seconds) => ({
				...(await ffmpegFrame(path, seconds, signal)),
				label: formatTime(seconds),
			})),
		);
		return {
			url: path,
			title: `${basename(path)} frames`,
			content: `Extracted frames at ${timestamps.map(formatTime).join(", ")}.`,
			images,
			...(Number.isFinite(duration) ? { duration } : {}),
		};
	}
	if (!geminiAvailable())
		return failure(
			path,
			"GEMINI_API_KEY is required to analyze a local video; use timestamp or frames for frame extraction",
		);
	const size = (await stat(path)).size;
	if (size > VIDEO_BYTES) return failure(path, "Local video exceeds the 50 MiB upload limit");
	let uploaded: Awaited<ReturnType<typeof geminiUploadVideo>> | undefined;
	try {
		uploaded = await geminiUploadVideo(path, mimeType, signal);
		const prompt =
			options.question?.trim() ||
			"Provide a title, summary, detailed timestamped transcript, and descriptions of important visuals. Format as markdown.";
		const content = await geminiGenerate([{ fileData: { fileUri: uploaded.uri, mimeType } }, { text: prompt }], {
			signal,
			timeoutMs: 120_000,
		});
		return bounded({ url: path, title: heading(content) || basename(path), content });
	} catch (error) {
		return failure(path, error);
	} finally {
		await uploaded?.cleanup();
	}
}

function frameTimes(timestamp: string | undefined, count: number | undefined, duration?: number): number[] {
	const wanted = Math.max(1, Math.min(12, count ?? (timestamp?.includes("-") ? 6 : 1)));
	if (timestamp) {
		const divider = timestamp.indexOf("-", 1);
		if (divider > 0) {
			const start = parseTime(timestamp.slice(0, divider));
			const end = parseTime(timestamp.slice(divider + 1));
			if (start === undefined || end === undefined || end <= start) throw new Error("Invalid timestamp range");
			return spaced(start, end, wanted);
		}
		const start = parseTime(timestamp);
		if (start === undefined) throw new Error("Invalid timestamp");
		return Array.from({ length: wanted }, (_, index) => start + index * 5);
	}
	if (duration === undefined) throw new Error("Could not determine video duration; provide timestamp");
	return spaced(0, Math.max(0, duration - 1), wanted);
}

function spaced(start: number, end: number, count: number): number[] {
	if (count === 1) return [start];
	return Array.from({ length: count }, (_, index) => Math.round(start + ((end - start) * index) / (count - 1)));
}
function parseTime(value: string): number | undefined {
	if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
	const parts = value.trim().split(":").map(Number);
	if (parts.some((part) => !Number.isFinite(part) || part < 0) || parts.length < 2 || parts.length > 3)
		return undefined;
	return parts.reduce((total, part) => total * 60 + part, 0);
}
function formatTime(seconds: number): string {
	const value = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(value / 3600);
	const minutes = Math.floor((value % 3600) / 60);
	const rest = value % 60;
	return hours
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
		: `${minutes}:${String(rest).padStart(2, "0")}`;
}

async function ffmpegFrame(source: string, seconds: number, signal?: AbortSignal): Promise<MediaImage> {
	const stdout = await runBuffer(
		"ffmpeg",
		[
			"-ss",
			String(seconds),
			"-i",
			source,
			"-frames:v",
			"1",
			"-vf",
			"scale='min(960,iw)':-2",
			"-q:v",
			"6",
			"-f",
			"image2pipe",
			"-vcodec",
			"mjpeg",
			"pipe:1",
		],
		signal,
		30_000,
		1024 * 1024,
	);
	if (!stdout.length) throw new Error("ffmpeg returned no frame");
	return { data: stdout.toString("base64"), mimeType: "image/jpeg" };
}

function vttToMarkdown(vtt: string): string {
	const lines = vtt.replace(/^WEBVTT[^\n]*\n/, "").split(/\n{2,}/);
	const seen = new Set<string>();
	const output: string[] = [];
	for (const block of lines) {
		const parts = block.split("\n").filter(Boolean);
		const timing = parts.find((line) => line.includes(" --> "));
		if (!timing) continue;
		const text = parts
			.slice(parts.indexOf(timing) + 1)
			.join(" ")
			.replace(/<[^>]+>/g, "")
			.replace(/&amp;/g, "&")
			.replace(/\s+/g, " ")
			.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		output.push(`**${timing.split(" --> ")[0].split(".")[0]}** ${text}`);
	}
	if (!output.length) throw new Error("Subtitle file contained no transcript");
	return output.join("\n\n");
}

async function readBytes(response: Response, max: number): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > max) throw new Error("Response is too large");
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel();
			throw new Error("Response is too large");
		}
		chunks.push(value);
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

function run(command: string, args: string[], signal?: AbortSignal, timeout = 30_000): Promise<string> {
	return new Promise((resolvePromise, reject) =>
		execFile(
			command,
			args,
			{ encoding: "utf8", timeout, signal, maxBuffer: 2 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) reject(new Error(commandError(command, error, stderr)));
				else resolvePromise(stdout);
			},
		),
	);
}
function runBuffer(
	command: string,
	args: string[],
	signal?: AbortSignal,
	timeout = 30_000,
	maxBuffer = 1024 * 1024,
): Promise<Buffer> {
	return new Promise((resolvePromise, reject) =>
		execFile(command, args, { encoding: "buffer", timeout, signal, maxBuffer }, (error, stdout, stderr) => {
			if (error) reject(new Error(commandError(command, error, stderr)));
			else resolvePromise(stdout as Buffer);
		}),
	);
}
function commandError(command: string, error: Error, stderr: string | Buffer): string {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT") return `${command} is not installed`;
	const detail = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
	return `${command} failed: ${(detail || error.message).replace(/\s+/g, " ").slice(0, 300)}`;
}
function videoMime(extension: string): string | undefined {
	return (
		{
			".mp4": "video/mp4",
			".mov": "video/quicktime",
			".webm": "video/webm",
			".avi": "video/x-msvideo",
			".mpeg": "video/mpeg",
			".mpg": "video/mpeg",
			".mkv": "video/x-matroska",
		} as Record<string, string>
	)[extension.toLowerCase()];
}
function youtubeId(url: URL): string | undefined {
	if (url.hostname === "youtu.be") return /^[\w-]{11}$/.test(url.pathname.slice(1)) ? url.pathname.slice(1) : undefined;
	if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) return undefined;
	const id =
		url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/live/") || url.pathname.startsWith("/embed/")
			? url.pathname.split("/")[2]
			: (url.searchParams.get("v") ?? undefined);
	return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}
function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}
function heading(text: string): string | undefined {
	return text.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim();
}
function textTitle(text: string, url: string): string {
	return heading(text) || basename(new URL(url).pathname) || new URL(url).hostname;
}
function bounded(value: Omit<ExtractedContent, "error">): ExtractedContent {
	const stored = storedText(value.content);
	return { ...value, content: stored.text, ...(stored.truncated ? { truncated: true } : {}), error: undefined };
}
function failure(url: string, error: unknown): ExtractedContent {
	return { url, title: "", content: "", error: errorMessage(error).slice(0, 1000) };
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function combinedSignal(signal: AbortSignal | undefined, timeout: number): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}
