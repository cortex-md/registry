import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import { createGitHub, GitHubError } from "./lib/github.mjs"
import { pruneStats, readRegistryEntries, readStats, statsItem, writeStats } from "./lib/registry-data.mjs"

export function countDownloads(kind, releases, bundleName) {
	let total = 0
	for (const release of releases) {
		if (release.draft) continue
		const assets = release.assets ?? []
		if (kind === "plugin") {
			total += assets.find((asset) => asset.name === bundleName)?.download_count ?? 0
		} else {
			const stylesheetDownloads = assets.filter((asset) => asset.name.endsWith(".css")).map((asset) => asset.download_count)
			total += stylesheetDownloads.length > 0 ? Math.max(...stylesheetDownloads) : 0
		}
	}
	return total
}

export async function updateStats({ rootDir = process.cwd(), github = createGitHub(), now = () => new Date(), log = console.log } = {}) {
	const registry = await readRegistryEntries(rootDir)
	const stats = await readStats(rootDir)
	pruneStats(stats, registry)

	for (const { kind, statsKey, entries } of registry) {
		for (const entry of entries) {
			const item = statsItem(stats, statsKey, entry.id)
			try {
				const [repository, releases] = await Promise.all([
					github.rest(`/repos/${entry.repo}`),
					github.paginate(`/repos/${entry.repo}/releases`),
				])
				const published = releases.filter((release) => !release.draft && !release.prerelease)
				const latest = published[0]
				const bundleName = kind === "plugin" ? await resolveBundleName(github, latest) : null
				const downloads = countDownloads(kind, releases, bundleName)

				item.downloads = Math.max(item.downloads ?? 0, downloads)
				item.stars = repository.stargazers_count ?? 0
				if (latest) {
					item.latest = latest.tag_name.replace(/^v/, "")
					item.releasedAt = latest.published_at
				}
			} catch (error) {
				if (!(error instanceof GitHubError)) throw error
				log(`skipped ${kind} ${entry.id}: ${error.message}`)
			}
		}
	}

	stats.generatedAt = now().toISOString()
	await writeStats(rootDir, stats)
}

async function resolveBundleName(github, release) {
	const manifestAsset = release?.assets?.find((asset) => asset.name === "manifest.json")
	if (!manifestAsset) return "index.js"
	try {
		const manifest = JSON.parse(await github.downloadText(manifestAsset.browser_download_url))
		return typeof manifest.main === "string" ? basename(manifest.main) : "index.js"
	} catch {
		return "index.js"
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await updateStats()
}
