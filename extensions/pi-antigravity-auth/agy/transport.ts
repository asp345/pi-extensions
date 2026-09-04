const AGY_RESPONSE_HEADER_TIMEOUT_MS = 180_000;
const AGY_IDLE_TIMEOUT_MS = 180_000;

interface AgyFetchOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	idleTimeoutMs?: number;
}

async function chunkedRequestBody(body: BodyInit): Promise<ReadableStream<Uint8Array>> {
	const bytes = new Uint8Array(await new Response(body).arrayBuffer());
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function withIdleTimeout(response: Response, idleTimeoutMs: number): Response {
	if (!response.body || idleTimeoutMs <= 0) return response;
	const reader = response.body.getReader();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await Promise.race([
					reader.read(),
					new Promise<never>((_, reject) => {
						timeout = setTimeout(
							() => reject(new Error(`Antigravity response stalled: no data for ${idleTimeoutMs}ms`)),
							idleTimeoutMs,
						);
					}),
				]);
				if (result.done) controller.close();
				else controller.enqueue(result.value);
			} catch (error) {
				await reader.cancel(error).catch(() => {});
				controller.error(error);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

export async function fetchWithAgyCliTransport(
	url: string,
	init: RequestInit & { body?: BodyInit | null } = {},
	options: AgyFetchOptions = {},
): Promise<Response> {
	const parsedUrl = new URL(url);
	if (parsedUrl.protocol !== "https:") {
		throw new Error(`agy transport only supports https URLs: ${url}`);
	}
	if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");

	const headers = new Headers(init.headers);
	let body = init.body;
	if (body != null && parsedUrl.pathname.includes(":streamGenerateContent")) {
		headers.set("Transfer-Encoding", "chunked");
		headers.delete("Content-Length");
		body = await chunkedRequestBody(body);
	}

	const timeoutMs = options.timeoutMs ?? AGY_RESPONSE_HEADER_TIMEOUT_MS;
	const timeoutController = new AbortController();
	const timeout = setTimeout(() => {
		timeoutController.abort(
			new Error(`Antigravity request timed out waiting for response headers after ${timeoutMs}ms`),
		);
	}, timeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeoutController.signal])
		: timeoutController.signal;
	try {
		const response = await fetch(url, { ...init, headers, body, signal });
		return withIdleTimeout(response, options.idleTimeoutMs ?? AGY_IDLE_TIMEOUT_MS);
	} finally {
		clearTimeout(timeout);
	}
}
