import { pathToFileURL } from "node:url"
import { createGitHub } from "./lib/github.mjs"
import { pruneStats, readRegistryEntries, readStats, REGISTRY_FILES, writeStats } from "./lib/registry-data.mjs"

const BATCH_SIZE = 100

const VOTES_QUERY = `query($ids: [ID!]!) {
	nodes(ids: $ids) {
		... on Discussion {
			id
			upvoteCount
		}
	}
}`

export async function updateVotes({ rootDir = process.cwd(), github = createGitHub(), now = () => new Date() } = {}) {
	const registry = await readRegistryEntries(rootDir)
	const stats = await readStats(rootDir)
	pruneStats(stats, registry)

	const targets = []
	for (const { statsKey } of REGISTRY_FILES) {
		for (const [id, item] of Object.entries(stats[statsKey])) {
			if (item.discussion?.nodeId) targets.push({ statsKey, id, nodeId: item.discussion.nodeId })
		}
	}

	for (let index = 0; index < targets.length; index += BATCH_SIZE) {
		const batch = targets.slice(index, index + BATCH_SIZE)
		const data = await github.graphql(VOTES_QUERY, { ids: batch.map((target) => target.nodeId) }, { allowNotFound: true })
		const counts = new Map((data.nodes ?? []).filter(Boolean).map((node) => [node.id, node.upvoteCount]))
		for (const target of batch) {
			const votes = counts.get(target.nodeId)
			if (votes === undefined) {
				delete stats[target.statsKey][target.id].discussion
				continue
			}
			stats[target.statsKey][target.id].votes = votes
		}
	}

	stats.generatedAt = now().toISOString()
	await writeStats(rootDir, stats)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await updateVotes()
}
