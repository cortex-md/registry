const API = "https://api.github.com"
const MAX_ATTEMPTS = 4
const MAX_RATE_LIMIT_WAIT_MS = 60_000

export class GitHubError extends Error {
	constructor(message, status) {
		super(message)
		this.name = "GitHubError"
		this.status = status
	}
}

export function createGitHub({ token = process.env.GITHUB_TOKEN, fetchImpl = fetch, sleep = defaultSleep } = {}) {
	function headers(extra = {}) {
		const base = {
			Accept: "application/vnd.github+json",
			"User-Agent": "cortex-registry-automation",
			"X-GitHub-Api-Version": "2022-11-28",
			...extra,
		}
		if (token) base.Authorization = `Bearer ${token}`
		return base
	}

	async function send(url, init = {}) {
		for (let attempt = 1; ; attempt++) {
			const response = await fetchImpl(url, { ...init, headers: headers(init.headers) })
			if (response.ok || response.status === 304) return response

			const retryAfter = retryDelay(response)
			if (retryAfter !== null && retryAfter <= MAX_RATE_LIMIT_WAIT_MS && attempt < MAX_ATTEMPTS) {
				await sleep(retryAfter)
				continue
			}
			if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
				await sleep(1000 * 2 ** attempt)
				continue
			}

			const body = await response.text().catch(() => "")
			throw new GitHubError(`${init.method ?? "GET"} ${url} returned ${response.status}: ${body.slice(0, 300)}`, response.status)
		}
	}

	async function rest(path, { method = "GET", body } = {}) {
		const response = await send(`${API}${path}`, {
			method,
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: body === undefined ? {} : { "Content-Type": "application/json" },
		})
		if (response.status === 204) return null
		return response.json()
	}

	async function paginate(path) {
		const items = []
		let url = `${API}${path}${path.includes("?") ? "&" : "?"}per_page=100`
		while (url) {
			const response = await send(url)
			items.push(...(await response.json()))
			url = nextLink(response.headers.get("link"))
		}
		return items
	}

	async function graphql(query, variables = {}, { allowNotFound = false } = {}) {
		const response = await send(`${API}/graphql`, {
			method: "POST",
			body: JSON.stringify({ query, variables }),
			headers: { "Content-Type": "application/json" },
		})
		const payload = await response.json()
		const notFoundOnly = payload.errors?.every((error) => error.type === "NOT_FOUND")
		if (payload.errors?.length && !(allowNotFound && notFoundOnly && payload.data)) {
			throw new GitHubError(`GraphQL: ${payload.errors.map((error) => error.message).join("; ")}`, 200)
		}
		return payload.data
	}

	async function downloadText(url) {
		const response = await send(url, { headers: { Accept: "application/octet-stream" } })
		return response.text()
	}

	async function exists(path) {
		try {
			await rest(path)
			return true
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return false
			throw error
		}
	}

	return { rest, paginate, graphql, downloadText, exists }
}

function retryDelay(response) {
	if (response.status !== 403 && response.status !== 429) return null
	const retryAfter = response.headers.get("retry-after")
	if (retryAfter) return Number(retryAfter) * 1000
	if (response.headers.get("x-ratelimit-remaining") === "0") {
		const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000
		return Math.max(0, reset - Date.now()) + 1000
	}
	return null
}

function nextLink(header) {
	if (!header) return null
	const match = header.split(",").find((part) => part.includes('rel="next"'))
	return match ? match.slice(match.indexOf("<") + 1, match.indexOf(">")) : null
}

function defaultSleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
