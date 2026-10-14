import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const REGISTRY_FILES = [
	{ kind: "plugin", fileName: "plugins.json", statsKey: "plugins" },
	{ kind: "theme", fileName: "themes.json", statsKey: "themes" },
]

export const STATS_FILE = "stats.json"
export const VERIFIED_FILE = "verified.json"
export const BLOCKED_FILE = "blocked.json"
export const MAINTAINER_FILES = [STATS_FILE, VERIFIED_FILE, BLOCKED_FILE]

const STATS_ITEM_FIELDS = ["downloads", "stars", "votes", "latest", "releasedAt", "discussion", "audit"]

export async function readJson(rootDir, fileName, fallback) {
	try {
		return JSON.parse(await readFile(join(rootDir, fileName), "utf8"))
	} catch (error) {
		if (error.code === "ENOENT") return fallback
		throw error
	}
}

export async function readRegistryEntries(rootDir) {
	const result = []
	for (const file of REGISTRY_FILES) {
		result.push({ ...file, entries: await readJson(rootDir, file.fileName, []) })
	}
	return result
}

export function emptyStats() {
	return { generatedAt: null, plugins: {}, themes: {} }
}

export async function readStats(rootDir) {
	const stats = await readJson(rootDir, STATS_FILE, emptyStats())
	return { ...emptyStats(), ...stats }
}

export async function writeStats(rootDir, stats) {
	await writeFile(join(rootDir, STATS_FILE), canonicalStatsJson(stats))
}

export function canonicalStatsJson(stats) {
	const canonical = { generatedAt: stats.generatedAt ?? null }
	for (const { statsKey } of REGISTRY_FILES) {
		canonical[statsKey] = {}
		for (const id of Object.keys(stats[statsKey] ?? {}).sort()) {
			const item = stats[statsKey][id]
			const ordered = {}
			for (const field of STATS_ITEM_FIELDS) {
				if (item[field] !== undefined) ordered[field] = item[field]
			}
			canonical[statsKey][id] = ordered
		}
	}
	return `${JSON.stringify(canonical, null, "\t")}\n`
}

export function statsItem(stats, statsKey, id) {
	stats[statsKey] ??= {}
	stats[statsKey][id] ??= {}
	return stats[statsKey][id]
}

export function pruneStats(stats, registry) {
	for (const { statsKey, entries } of registry) {
		const listed = new Set(entries.map((entry) => entry.id))
		for (const id of Object.keys(stats[statsKey] ?? {})) {
			if (!listed.has(id)) delete stats[statsKey][id]
		}
	}
}

export function canonicalListJson(entries, fields) {
	const sorted = [...entries]
		.map((entry) => {
			const ordered = {}
			for (const field of fields) {
				if (entry[field] !== undefined) ordered[field] = entry[field]
			}
			return ordered
		})
		.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
	return `${JSON.stringify(sorted, null, "\t")}\n`
}

export const VERIFIED_FIELDS = ["kind", "id", "since"]
export const BLOCKED_FIELDS = ["kind", "id", "repo", "reason", "versions", "since"]

export function findBlock(blocked, kind, id) {
	return blocked.find((entry) => entry.kind === kind && entry.id === id)
}

export function isVersionBlocked(block, version) {
	if (!block) return false
	return block.versions === null || block.versions.includes(version)
}
