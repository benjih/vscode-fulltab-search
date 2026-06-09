export interface RequestOptions {
	timeoutMs?: number
	retries?: number
	headers?: Record<string, string>
}

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly url: string,
	) {
		super(`Request to ${url} failed with status ${status}`)
	}
}

export async function fetchJson<T>(
	url: string,
	options: RequestOptions = {},
): Promise<T> {
	const { timeoutMs = 5000, retries = 2, headers = {} } = options

	for (let attempt = 0; attempt <= retries; attempt++) {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response = await fetch(url, { headers, signal: controller.signal })
			if (!response.ok) {
				throw new HttpError(response.status, url)
			}
			return (await response.json()) as T
		} catch (error) {
			if (attempt === retries) {
				throw error
			}
		} finally {
			clearTimeout(timer)
		}
	}

	throw new Error("unreachable")
}
