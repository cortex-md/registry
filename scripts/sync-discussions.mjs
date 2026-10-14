import { pathToFileURL } from "node:url"
import { createGitHub } from "./lib/github.mjs"
import { pruneStats, readRegistryEntries, readStats, statsItem, writeStats } from "./lib/registry-data.mjs"

const CATEGORY_BY_KIND = { plugin: "Plugins", theme: "Themes" }

const REPOSITORY_QUERY = `query($owner: String!, $name: String!) {
	repository(owner: $owner, name: $name) {
		id
		discussionCategories(first: 50) { nodes { id name } }
	}
}`

const DISCUSSIONS_QUERY = `query($owner: String!, $name: String!, $categoryId: ID!, $after: String) {
	repository(owner: $owner, name: $name) {
		discussions(first: 100, after: $after, categoryId: $categoryId) {
			pageInfo { hasNextPage endCursor }
			nodes { id number title url locked }
		}
	}
}`

const CREATE_MUTATION = `mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
	createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) {
		discussion { id number url locked }
	}
}`

const COMMENT_MUTATION = `mutation($discussionId: ID!, $body: String!) {
	addDiscussionComment(input: { discussionId: $discussionId, body: $body }) { comment { id } }
}`

const LOCK_MUTATION = `mutation($id: ID!) { lockLockable(input: { lockableId: $id, lockReason: RESOLVED }) { clientMutationId } }`
const UNLOCK_MUTATION = `mutation($id: ID!) { unlockLockable(input: { lockableId: $id }) { clientMutationId } }`

export function discussionTitle(kind, id) {
	return `${kind}: ${id}`
}

export function discussionBody(kind, entry) {
	return [
		`**${entry.name}** by ${entry.author}`,
		"",
		entry.description,
		"",
		`- Repository: https://github.com/${entry.repo}`,
		`- Install: open Cortex → Marketplace → ${CATEGORY_BY_KIND[kind]} and search for **${entry.name}**`,
		"",
		`👍 **React with a thumbs up to vote for this ${kind}.** Only 👍 reactions on this post are counted.`,
		"",
		"Comments are welcome for reviews, questions and feedback. Report security or abuse problems with the \"Report a plugin or theme\" issue form instead.",
	].join("\n")
}

export async function syncDiscussions({ rootDir = process.cwd(), github = createGitHub(), repository = process.env.GITHUB_REPOSITORY, log = console.log } = {}) {
	const [owner, name] = repository.split("/")
	const registry = await readRegistryEntries(rootDir)
	const stats = await readStats(rootDir)
	pruneStats(stats, registry)

	const { repository: repo } = await github.graphql(REPOSITORY_QUERY, { owner, name })
	const categories = new Map(repo.discussionCategories.nodes.map((category) => [category.name, category.id]))

	for (const { kind, statsKey, entries } of registry) {
		const categoryName = CATEGORY_BY_KIND[kind]
		const categoryId = categories.get(categoryName)
		if (!categoryId) {
			throw new Error(`Discussion category "${categoryName}" does not exist. Create it (Announcement format) in the repository settings.`)
		}

		const existing = await listDiscussions(github, owner, name, categoryId)
		const byTitle = new Map(existing.map((discussion) => [discussion.title, discussion]))
		const listedTitles = new Set()

		for (const entry of entries) {
			const title = discussionTitle(kind, entry.id)
			listedTitles.add(title)
			let discussion = byTitle.get(title)

			if (!discussion) {
				const created = await github.graphql(CREATE_MUTATION, {
					repositoryId: repo.id,
					categoryId,
					title,
					body: discussionBody(kind, entry),
				})
				discussion = created.createDiscussion.discussion
				log(`created discussion #${discussion.number} for ${kind} ${entry.id}`)
			} else if (discussion.locked) {
				await github.graphql(UNLOCK_MUTATION, { id: discussion.id })
				log(`unlocked discussion #${discussion.number} for relisted ${kind} ${entry.id}`)
			}

			statsItem(stats, statsKey, entry.id).discussion = {
				number: discussion.number,
				nodeId: discussion.id,
				url: discussion.url,
			}
		}

		for (const discussion of existing) {
			if (listedTitles.has(discussion.title) || discussion.locked || !discussion.title.startsWith(`${kind}: `)) continue
			await github.graphql(COMMENT_MUTATION, {
				discussionId: discussion.id,
				body: `This ${kind} is no longer listed in the Cortex Marketplace, so voting is closed.`,
			})
			await github.graphql(LOCK_MUTATION, { id: discussion.id })
			log(`locked discussion #${discussion.number} for unlisted ${discussion.title}`)
		}
	}

	await writeStats(rootDir, stats)
}

async function listDiscussions(github, owner, name, categoryId) {
	const discussions = []
	let after = null
	do {
		const data = await github.graphql(DISCUSSIONS_QUERY, { owner, name, categoryId, after })
		const page = data.repository.discussions
		discussions.push(...page.nodes)
		after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
	} while (after)
	return discussions
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await syncDiscussions()
}
