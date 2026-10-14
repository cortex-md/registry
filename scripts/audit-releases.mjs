import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import { auditStatus, scanPluginBundle, scanThemeStylesheet } from "./lib/bundle-scan.mjs"
import { createGitHub, GitHubError } from "./lib/github.mjs"
import {
	BLOCKED_FIELDS,
	BLOCKED_FILE,
	canonicalListJson,
	findBlock,
	isVersionBlocked,
	pruneStats,
	readJson,
	readRegistryEntries,
	readStats,
	statsItem,
	writeStats,
} from "./lib/registry-data.mjs"
import { validatePluginRelease, validateThemeRelease } from "./validate-registry.mjs"

const BASE_BRANCH = "main"
const AUDIT_LABEL = "audit"

export async function auditEntry(github, kind, entry) {
	const release = await github.rest(`/repos/${entry.repo}/releases/latest`)
	const tag = release.tag_name
	const version = tag.replace(/^v/, "")
	const manifestAsset = release.assets.find((asset) => asset.name === "manifest.json")
	if (!manifestAsset) {
		return { tag, version, findings: [{ level: "fail", message: "latest release has no manifest.json asset" }] }
	}

	const manifestSource = await github.downloadText(manifestAsset.browser_download_url)
	const releaseIssues = kind === "plugin" ? validatePluginRelease(entry, release, manifestSource) : validateThemeRelease(entry, release, manifestSource)
	const findings = releaseIssues.map((message) => ({ level: "fail", message: message.replace(`${entry.id}: `, "") }))

	const manifest = safeParse(manifestSource)
	if (kind === "plugin" && typeof manifest?.main === "string") {
		const bundle = release.assets.find((asset) => asset.name === manifest.main) ?? release.assets.find((asset) => asset.name === basename(manifest.main))
		if (bundle) findings.push(...scanPluginBundle(await github.downloadText(bundle.browser_download_url)))
	}
	if (kind === "theme") {
		for (const asset of release.assets.filter((candidate) => candidate.name.endsWith(".css"))) {
			findings.push(...scanThemeStylesheet(asset.name, await github.downloadText(asset.browser_download_url)))
		}
	}

	return { tag, version, findings }
}

export async function auditReleases({ rootDir = process.cwd(), github = createGitHub(), repository = process.env.GITHUB_REPOSITORY, now = () => new Date(), log = console.log } = {}) {
	const registry = await readRegistryEntries(rootDir)
	const stats = await readStats(rootDir)
	const blocked = await readJson(rootDir, BLOCKED_FILE, [])
	pruneStats(stats, registry)
	const openIssues = await listOpenAuditIssues(github, repository)

	for (const { kind, statsKey, entries } of registry) {
		for (const entry of entries) {
			let result
			try {
				result = await auditEntry(github, kind, entry)
			} catch (error) {
				if (!(error instanceof GitHubError)) throw error
				log(`skipped ${kind} ${entry.id}: ${error.message}`)
				continue
			}

			const status = auditStatus(result.findings)
			statsItem(stats, statsKey, entry.id).audit = {
				status,
				checkedTag: result.tag,
				checkedAt: now().toISOString(),
				issues: result.findings.map((finding) => `${finding.level}: ${finding.message}`),
			}

			const issueTitle = `audit: ${kind} ${entry.id}`
			const openIssue = openIssues.find((issue) => issue.title === issueTitle)
			if (status === "fail") {
				const issueNumber = await reportFailure(github, repository, openIssue, issueTitle, kind, entry, result)
				if (!isVersionBlocked(findBlock(blocked, kind, entry.id), result.version)) {
					await proposeBlock(github, repository, kind, entry, result, issueNumber, now(), log)
				}
			} else if (openIssue) {
				await github.rest(`/repos/${repository}/issues/${openIssue.number}/comments`, {
					method: "POST",
					body: { body: `Release ${result.tag} passes the audit (${status}). Closing.` },
				})
				await github.rest(`/repos/${repository}/issues/${openIssue.number}`, { method: "PATCH", body: { state: "closed" } })
			}
		}
	}

	stats.generatedAt = now().toISOString()
	await writeStats(rootDir, stats)
}

async function listOpenAuditIssues(github, repository) {
	const issues = await github.paginate(`/repos/${repository}/issues?state=open&labels=${AUDIT_LABEL}`)
	return issues.filter((issue) => !issue.pull_request)
}

async function reportFailure(github, repository, openIssue, title, kind, entry, result) {
	const findings = result.findings.map((finding) => `- **${finding.level}**: ${finding.message}`).join("\n")
	const marker = `<!-- audit:${result.tag} -->`
	const body = `${marker}\nRelease [${result.tag}](https://github.com/${entry.repo}/releases/tag/${result.tag}) of ${kind} \`${entry.id}\` failed the automated audit.\n\n${findings}\n\nMaintainers: review the findings and merge or close the proposed block pull request. Authors: run \`cortex check\` and publish a fixed release.`

	if (!openIssue) {
		const created = await github.rest(`/repos/${repository}/issues`, { method: "POST", body: { title, body, labels: [AUDIT_LABEL] } })
		return created.number
	}
	if (!openIssue.body?.includes(marker)) {
		const comments = await github.paginate(`/repos/${repository}/issues/${openIssue.number}/comments`)
		if (!comments.some((comment) => comment.body?.includes(marker))) {
			await github.rest(`/repos/${repository}/issues/${openIssue.number}/comments`, { method: "POST", body: { body } })
		}
	}
	return openIssue.number
}

async function proposeBlock(github, repository, kind, entry, result, issueNumber, date, log) {
	const branch = `audit/block-${kind}-${entry.id}-${result.version}`
	if (await github.exists(`/repos/${repository}/git/ref/heads/${branch}`)) return

	const base = await github.rest(`/repos/${repository}/git/ref/heads/${BASE_BRANCH}`)
	await github.rest(`/repos/${repository}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: base.object.sha } })

	const file = await github.rest(`/repos/${repository}/contents/${BLOCKED_FILE}?ref=${branch}`)
	const blocked = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"))
	const existing = findBlock(blocked, kind, entry.id)
	if (existing && existing.versions !== null) {
		existing.versions = [...new Set([...existing.versions, result.version])]
	} else if (!existing) {
		blocked.push({
			kind,
			id: entry.id,
			repo: entry.repo,
			reason: `Automated audit failed for ${result.tag} (#${issueNumber})`,
			versions: [result.version],
			since: date.toISOString().slice(0, 10),
		})
	}

	await github.rest(`/repos/${repository}/contents/${BLOCKED_FILE}`, {
		method: "PUT",
		body: {
			message: `chore(registry): block ${kind} ${entry.id} ${result.tag}`,
			content: Buffer.from(canonicalListJson(blocked, BLOCKED_FIELDS)).toString("base64"),
			sha: file.sha,
			branch,
		},
	})
	const pull = await github.rest(`/repos/${repository}/pulls`, {
		method: "POST",
		body: {
			title: `Block ${kind} ${entry.id} ${result.tag}`,
			head: branch,
			base: BASE_BRANCH,
			body: `Proposed by the automated audit. See #${issueNumber}.\n\nMerging hides ${result.tag} from the Marketplace and stops Cortex from offering it as an update. Close this pull request if the findings are false positives.`,
		},
	})
	await github.rest(`/repos/${repository}/issues/${pull.number}/labels`, { method: "POST", body: { labels: [AUDIT_LABEL] } })
	log(`proposed block for ${kind} ${entry.id} ${result.tag} in #${pull.number}`)
}

function safeParse(source) {
	try {
		return JSON.parse(source)
	} catch {
		return null
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await auditReleases()
}
