import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { PLUGIN_PERMISSIONS } from "./lib/bundle-scan.mjs"
import {
	BLOCKED_FIELDS,
	BLOCKED_FILE,
	canonicalListJson,
	canonicalStatsJson,
	MAINTAINER_FILES,
	REGISTRY_FILES,
	STATS_FILE,
	VERIFIED_FIELDS,
	VERIFIED_FILE,
} from "./lib/registry-data.mjs"

const ENTRY_FIELDS = ["id", "name", "author", "authorUrl", "description", "coverImageUrl", "repo"]

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])
const AUTOMATION_LOGINS = new Set(["github-actions[bot]"])

export class RegistryValidationError extends Error {
	constructor(issues) {
		super(`Registry validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}`)
		this.name = "RegistryValidationError"
		this.issues = issues
	}
}

export function canonicalRegistryJson(entries) {
	return `${JSON.stringify(canonicalEntries(entries), null, "\t")}\n`
}

export function canonicalEntries(entries) {
	return entries
		.map((entry) => normalizeEntry(entry))
		.sort((left, right) => left.id.localeCompare(right.id))
}

export function validateRegistryEntries(kind, entries, sourceName = `${kind}s.json`) {
	const issues = []
	const normalizedEntries = []
	const seenIds = new Set()

	if (!Array.isArray(entries)) {
		return {
			entries: [],
			issues: [`${sourceName}: expected a JSON array`],
		}
	}

	entries.forEach((entry, index) => {
		const label = `${sourceName}[${index}]`
		const entryIssues = validateEntryShape(entry, kind, label)
		issues.push(...entryIssues)
		if (entryIssues.length > 0 || !isRecord(entry)) return

		if (seenIds.has(entry.id)) {
			issues.push(`${label}: duplicate id "${entry.id}"`)
			return
		}
		seenIds.add(entry.id)
		normalizedEntries.push(normalizeEntry(entry))
	})

	const sortedIds = [...seenIds].sort((left, right) => left.localeCompare(right))
	const actualIds = normalizedEntries.map((entry) => entry.id)
	if (actualIds.some((id, index) => id !== sortedIds[index])) {
		issues.push(`${sourceName}: entries must be sorted by id`)
	}

	return { entries: normalizedEntries, issues }
}

export function validateCrossRegistryIds(entriesByKind) {
	const issues = []
	const owners = new Map()

	for (const { kind, entries } of entriesByKind) {
		for (const entry of entries) {
			const previousKind = owners.get(entry.id)
			if (previousKind) {
				issues.push(`id "${entry.id}" is declared as both ${previousKind} and ${kind}`)
			} else {
				owners.set(entry.id, kind)
			}
		}
	}

	return issues
}

export async function validateRegistry(rootDir = process.cwd(), options = {}) {
	const checkRemote = options.checkRemote ?? true
	const token = options.token ?? process.env.GITHUB_TOKEN
	const issues = []
	const entriesByKind = []

	for (const registryFile of REGISTRY_FILES) {
		const filePath = join(rootDir, registryFile.fileName)
		let source
		try {
			source = await readFile(filePath, "utf8")
		} catch (error) {
			issues.push(`${registryFile.fileName}: could not read file: ${getErrorMessage(error)}`)
			continue
		}

		let parsed
		try {
			parsed = JSON.parse(source)
		} catch (error) {
			issues.push(`${registryFile.fileName}: invalid JSON: ${getErrorMessage(error)}`)
			continue
		}

		const validation = validateRegistryEntries(registryFile.kind, parsed, registryFile.fileName)
		issues.push(...validation.issues)
		entriesByKind.push({ kind: registryFile.kind, entries: validation.entries })

		if (Array.isArray(parsed) && source !== canonicalRegistryJson(parsed)) {
			issues.push(`${registryFile.fileName}: formatting or field order does not match canonical output`)
		}
	}

	issues.push(...validateCrossRegistryIds(entriesByKind))
	issues.push(...(await validateMaintainerFiles(rootDir, entriesByKind)))
	if (options.pullRequest) {
		issues.push(...validatePullRequestScope(options.pullRequest, options.changedFiles ?? []))
	}

	if (checkRemote) {
		const remoteEntries = options.baseRef
			? selectChangedEntries(entriesByKind, (fileName) => readBaseFile(rootDir, options.baseRef, fileName))
			: entriesByKind
		const remoteIssues = await validateRemoteEntries(remoteEntries, token)
		issues.push(...remoteIssues)
	}

	if (issues.length > 0) throw new RegistryValidationError(issues)
	return { entriesByKind }
}

export async function validateMaintainerFiles(rootDir, entriesByKind) {
	const issues = []
	const idsByKind = new Map(entriesByKind.map(({ kind, entries }) => [kind, new Map(entries.map((entry) => [entry.id, entry]))]))

	const verified = await readListFile(rootDir, VERIFIED_FILE, VERIFIED_FIELDS, issues)
	for (const [index, entry] of verified.entries()) {
		const label = `${VERIFIED_FILE}[${index}]`
		if (!idsByKind.has(entry.kind)) issues.push(`${label}: kind must be plugin or theme`)
		else if (!idsByKind.get(entry.kind).has(entry.id)) issues.push(`${label}: ${entry.kind} "${entry.id}" is not listed`)
		if (!isIsoDate(entry.since)) issues.push(`${label}: since must be an ISO date (YYYY-MM-DD)`)
	}

	const blocked = await readListFile(rootDir, BLOCKED_FILE, BLOCKED_FIELDS, issues)
	for (const [index, entry] of blocked.entries()) {
		const label = `${BLOCKED_FILE}[${index}]`
		if (!idsByKind.has(entry.kind)) issues.push(`${label}: kind must be plugin or theme`)
		if (typeof entry.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo)) {
			issues.push(`${label}: repo must use owner/repo format`)
		}
		if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) issues.push(`${label}: reason is required`)
		if (!isIsoDate(entry.since)) issues.push(`${label}: since must be an ISO date (YYYY-MM-DD)`)
		if (entry.versions !== null && !(Array.isArray(entry.versions) && entry.versions.length > 0 && entry.versions.every(isSemver))) {
			issues.push(`${label}: versions must be null (whole item) or a non-empty list of MAJOR.MINOR.PATCH versions`)
		}
		const listed = idsByKind.get(entry.kind)?.get(entry.id)
		if (entry.versions === null && listed && listed.repo !== entry.repo) {
			issues.push(`${label}: blocked id "${entry.id}" cannot be reused by another repository (${listed.repo})`)
		}
	}

	let statsSource = null
	try {
		statsSource = await readFile(join(rootDir, STATS_FILE), "utf8")
	} catch (error) {
		if (error.code !== "ENOENT") issues.push(`${STATS_FILE}: could not read file: ${getErrorMessage(error)}`)
	}
	if (statsSource !== null) {
		try {
			const stats = JSON.parse(statsSource)
			if (!isRecord(stats) || !isRecord(stats.plugins) || !isRecord(stats.themes)) {
				issues.push(`${STATS_FILE}: expected { generatedAt, plugins, themes }`)
			} else if (statsSource !== canonicalStatsJson(stats)) {
				issues.push(`${STATS_FILE}: formatting does not match canonical output`)
			}
		} catch (error) {
			issues.push(`${STATS_FILE}: invalid JSON: ${getErrorMessage(error)}`)
		}
	}

	return issues
}

export function validatePullRequestScope(pullRequest, changedFiles) {
	const protectedChanges = changedFiles.filter((file) => MAINTAINER_FILES.includes(file))
	if (protectedChanges.length === 0) return []
	if (MAINTAINER_ASSOCIATIONS.has(pullRequest.authorAssociation)) return []
	if (AUTOMATION_LOGINS.has(pullRequest.login) && protectedChanges.every((file) => file === BLOCKED_FILE)) return []
	return [`${protectedChanges.join(", ")} can only be changed by registry maintainers`]
}

async function readListFile(rootDir, fileName, fields, issues) {
	let source
	try {
		source = await readFile(join(rootDir, fileName), "utf8")
	} catch (error) {
		if (error.code === "ENOENT") return []
		issues.push(`${fileName}: could not read file: ${getErrorMessage(error)}`)
		return []
	}
	let parsed
	try {
		parsed = JSON.parse(source)
	} catch (error) {
		issues.push(`${fileName}: invalid JSON: ${getErrorMessage(error)}`)
		return []
	}
	if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
		issues.push(`${fileName}: expected a JSON array of objects`)
		return []
	}
	const seen = new Set()
	for (const entry of parsed) {
		const key = `${entry.kind}:${entry.id}`
		if (seen.has(key)) issues.push(`${fileName}: duplicate entry ${key}`)
		seen.add(key)
		for (const field of Object.keys(entry)) {
			if (!fields.includes(field)) issues.push(`${fileName}: unknown field "${field}" in ${key}`)
		}
	}
	if (source !== canonicalListJson(parsed, fields)) {
		issues.push(`${fileName}: formatting, ordering or field order does not match canonical output`)
	}
	return parsed
}

function isIsoDate(value) {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export function selectChangedEntries(entriesByKind, readBase) {
	return entriesByKind.map(({ kind, entries }) => {
		const fileName = REGISTRY_FILES.find((file) => file.kind === kind).fileName
		const baseEntries = parseBaseEntries(readBase(fileName))
		const baseById = new Map(baseEntries.map((entry) => [entry.id, JSON.stringify(normalizeEntry(entry))]))
		return {
			kind,
			entries: entries.filter((entry) => baseById.get(entry.id) !== JSON.stringify(normalizeEntry(entry))),
		}
	})
}

function parseBaseEntries(source) {
	if (!source) return []
	try {
		const parsed = JSON.parse(source)
		return Array.isArray(parsed) ? parsed.filter(isRecord) : []
	} catch {
		return []
	}
}

function readBaseFile(rootDir, baseRef, fileName) {
	try {
		return execFileSync("git", ["show", `${baseRef}:${fileName}`], { cwd: rootDir, encoding: "utf8" })
	} catch {
		return ""
	}
}

export function validatePluginRelease(entry, release, manifestSource) {
	const issues = []
	const manifest = parseManifestSource(entry, manifestSource, "plugin")
	if (!manifest.value) return manifest.issues

	issues.push(...validatePluginManifest(entry, manifest.value))

	const mainPath =
		typeof manifest.value.main === "string"
			? normalizeRelativePath(manifest.value.main, "plugin main")
			: null
	if (mainPath && !findAsset(release.assets, mainPath) && !findAsset(release.assets, basename(mainPath))) {
		issues.push(`${entry.id}: release is missing plugin main asset "${mainPath}"`)
	}

	issues.push(...validateReleaseTag(entry, release, manifest.value))
	return issues
}

export function validateThemeRelease(entry, release, manifestSource) {
	const issues = []
	const manifest = parseManifestSource(entry, manifestSource, "theme")
	if (!manifest.value) return manifest.issues

	issues.push(...validateThemeManifest(entry, manifest.value))
	issues.push(...validateReleaseTag(entry, release, manifest.value))

	if (isRecord(manifest.value.colorschemes)) {
		for (const colorScheme of ["dark", "light"]) {
			const cssFile = manifest.value.colorschemes[colorScheme]
			const normalizedCssFile =
				typeof cssFile === "string" ? normalizeRelativePath(cssFile, "theme stylesheet") : null
			if (!normalizedCssFile) continue

			const matchingAsset =
				findAsset(release.assets, normalizedCssFile) ??
				findAsset(release.assets, basename(normalizedCssFile)) ??
				findAsset(release.assets, `${colorScheme}.css`)
			if (!matchingAsset) {
				issues.push(
					`${entry.id}: release is missing ${colorScheme} stylesheet asset "${normalizedCssFile}"`,
				)
			}
		}
	}

	return issues
}

function validateEntryShape(entry, kind, label) {
	const issues = []
	if (!isRecord(entry)) return [`${label}: expected an object`]

	for (const field of ["id", "name", "author", "description", "coverImageUrl", "repo"]) {
		if (typeof entry[field] !== "string") {
			issues.push(`${label}: ${field} must be a string`)
		} else if (field !== "coverImageUrl" && entry[field].trim().length === 0) {
			issues.push(`${label}: ${field} must not be empty`)
		}
	}

	if (typeof entry.id === "string" && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(entry.id)) {
		issues.push(`${label}: id must be a lowercase slug`)
	}
	if (typeof entry.repo === "string" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo)) {
		issues.push(`${label}: repo must use owner/repo format`)
	}
	if (
		typeof entry.coverImageUrl === "string" &&
		entry.coverImageUrl.length > 0 &&
		!entry.coverImageUrl.startsWith("https://")
	) {
		issues.push(`${label}: coverImageUrl must be empty or an https URL`)
	}
	if (entry.authorUrl !== undefined && !isHttpsUrl(entry.authorUrl)) {
		issues.push(`${label}: authorUrl must be an https URL when provided`)
	}

	for (const field of Object.keys(entry)) {
		if (!ENTRY_FIELDS.includes(field)) issues.push(`${label}: unknown field "${field}"`)
	}

	if (kind !== "plugin" && kind !== "theme") issues.push(`${label}: unknown registry kind "${kind}"`)

	return issues
}

function normalizeEntry(entry) {
	const normalized = {}
	for (const field of ENTRY_FIELDS) {
		if (entry[field] !== undefined) normalized[field] = entry[field]
	}
	return normalized
}

async function validateRemoteEntries(entriesByKind, token) {
	const validations = entriesByKind.flatMap(({ kind, entries }) =>
		entries.map(async (entry) => {
			const prefix = `${kind} ${entry.id}`
			try {
				return await validateRemoteEntry(kind, entry, token)
			} catch (error) {
				return [`${prefix}: ${getErrorMessage(error)}`]
			}
		}),
	)
	const results = await Promise.all(validations)
	return results.flat()
}

async function validateRemoteEntry(kind, entry, token) {
	const issues = []
	const repo = await fetchGitHubJson(`https://api.github.com/repos/${entry.repo}`, token)
	if (repo.private) issues.push(`${entry.id}: repository must be public`)

	const release = await fetchGitHubJson(
		`https://api.github.com/repos/${entry.repo}/releases/latest`,
		token,
	)
	if (!Array.isArray(release.assets)) {
		issues.push(`${entry.id}: latest release is missing assets`)
		return issues
	}

	if (!(await hasReadmeOnMainOrMaster(entry.repo))) {
		issues.push(`${entry.id}: README.md must exist on main or master`)
	}

	const manifestAsset = findAsset(release.assets, "manifest.json")
	if (!manifestAsset) {
		issues.push(`${entry.id}: latest release is missing manifest.json`)
		return issues
	}

	const manifestSource = await fetchText(manifestAsset.browser_download_url, token)
	if (kind === "plugin") {
		issues.push(...validatePluginRelease(entry, release, manifestSource))
	} else {
		issues.push(...validateThemeRelease(entry, release, manifestSource))
	}

	return issues
}

function validatePluginManifest(entry, manifest) {
	const issues = []
	for (const field of ["id", "name", "version", "minAppVersion", "author", "description", "icon", "main"]) {
		if (typeof manifest[field] !== "string" || manifest[field].trim().length === 0) {
			issues.push(`${entry.id}: manifest.${field} must be a non-empty string`)
		}
	}
	if (manifest.id !== entry.id) issues.push(`${entry.id}: manifest.id must match registry id`)
	if (typeof manifest.version === "string" && !isSemver(manifest.version)) {
		issues.push(`${entry.id}: manifest.version must be semver`)
	}
	if (typeof manifest.minAppVersion === "string" && !isSemver(manifest.minAppVersion)) {
		issues.push(`${entry.id}: manifest.minAppVersion must be semver`)
	}
	if (typeof manifest.main === "string" && !normalizeRelativePath(manifest.main, "plugin main")) {
		issues.push(`${entry.id}: manifest.main must be a safe relative path`)
	}
	for (const field of ["permissions", "capabilities"]) {
		const values = manifest[field]
		if (values === undefined) continue
		if (!Array.isArray(values)) {
			issues.push(`${entry.id}: manifest.${field} must be an array when provided`)
			continue
		}
		const unknown = values.filter((permission) => !PLUGIN_PERMISSIONS.has(permission))
		if (unknown.length > 0) {
			issues.push(`${entry.id}: unknown plugin permissions in manifest.${field}: ${unknown.join(", ")}`)
		}
	}
	return issues
}

function validateThemeManifest(entry, manifest) {
	const issues = []
	for (const field of ["id", "name", "displayName", "author", "version"]) {
		if (typeof manifest[field] !== "string" || manifest[field].trim().length === 0) {
			issues.push(`${entry.id}: manifest.${field} must be a non-empty string`)
		}
	}
	if (manifest.id !== entry.id) issues.push(`${entry.id}: manifest.id must match registry id`)
	if (typeof manifest.name === "string" && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) {
		issues.push(`${entry.id}: manifest.name must be a lowercase theme family slug`)
	} else if (manifest.name !== entry.id) {
		issues.push(`${entry.id}: manifest.name must equal the registry id so Cortex can detect installed themes`)
	}
	if (typeof manifest.version === "string" && !isSemver(manifest.version)) {
		issues.push(`${entry.id}: manifest.version must be semver`)
	}
	if (manifest.minAppVersion !== undefined && !isSemver(manifest.minAppVersion)) {
		issues.push(`${entry.id}: manifest.minAppVersion must be semver when provided`)
	}
	if (manifest.authorUrl !== undefined && !isHttpsUrl(manifest.authorUrl)) {
		issues.push(`${entry.id}: manifest.authorUrl must be an https URL when provided`)
	}
	if (!isRecord(manifest.colorschemes)) {
		issues.push(`${entry.id}: manifest.colorschemes must define dark and light paths`)
		return issues
	}
	for (const colorScheme of ["dark", "light"]) {
		const cssFile = manifest.colorschemes[colorScheme]
		if (typeof cssFile !== "string" || !normalizeRelativePath(cssFile, "theme stylesheet")) {
			issues.push(`${entry.id}: manifest.colorschemes.${colorScheme} must be a safe relative path`)
		}
	}
	return issues
}

function validateReleaseTag(entry, release, manifest) {
	if (typeof manifest.version !== "string" || typeof release.tag_name !== "string") return []
	if (release.tag_name.replace(/^v/, "") !== manifest.version) {
		return [`${entry.id}: release tag ${release.tag_name} must match manifest.version ${manifest.version}`]
	}
	return []
}

function parseManifestSource(entry, source, kind) {
	try {
		const value = JSON.parse(source)
		if (!isRecord(value)) return { value: null, issues: [`${entry.id}: ${kind} manifest must be an object`] }
		return { value, issues: [] }
	} catch (error) {
		return { value: null, issues: [`${entry.id}: ${kind} manifest is invalid JSON: ${getErrorMessage(error)}`] }
	}
}

function findAsset(assets, name) {
	return Array.isArray(assets) ? assets.find((asset) => asset.name === name) : undefined
}

function normalizeRelativePath(path, _description) {
	const normalized = path.replaceAll("\\", "/").trim()
	const segments = normalized.split("/").filter((segment) => segment && segment !== ".")
	if (
		normalized.length === 0 ||
		normalized.startsWith("/") ||
		/^[a-zA-Z]:/.test(normalized) ||
		segments.length === 0 ||
		segments.some((segment) => segment === "..")
	) {
		return null
	}
	return segments.join("/")
}

async function fetchGitHubJson(url, token) {
	const response = await fetch(url, {
		headers: createGitHubHeaders(token),
	})
	if (!response.ok) throw new Error(`${url} returned ${response.status}`)
	return response.json()
}

async function fetchText(url, token) {
	const response = await fetch(url, {
		headers: createGitHubHeaders(token),
	})
	if (!response.ok) throw new Error(`${url} returned ${response.status}`)
	return response.text()
}

async function hasReadmeOnMainOrMaster(repo) {
	const responses = await Promise.all(
		["main", "master"].map((branch) =>
			fetch(`https://raw.githubusercontent.com/${repo}/${branch}/README.md`, {
				headers: { "User-Agent": "cortex-registry-validator" },
			}),
		),
	)
	return responses.some((response) => response.ok)
}

function createGitHubHeaders(token) {
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "cortex-registry-validator",
		"X-GitHub-Api-Version": "2022-11-28",
	}
	if (token) headers.Authorization = `Bearer ${token}`
	return headers
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isHttpsUrl(value) {
	if (typeof value !== "string") return false
	try {
		return new URL(value).protocol === "https:"
	} catch {
		return false
	}
}

function isSemver(value) {
	return typeof value === "string" && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)
}

function getErrorMessage(error) {
	return error instanceof Error ? error.message : String(error)
}

async function readPullRequestContext() {
	if (!process.env.GITHUB_EVENT_PATH) return null
	try {
		const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"))
		if (!event.pull_request) return null
		return { authorAssociation: event.pull_request.author_association, login: event.pull_request.user?.login }
	} catch {
		return null
	}
}

function listChangedFiles(rootDir, baseRef) {
	try {
		return execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], { cwd: rootDir, encoding: "utf8" })
			.split("\n")
			.filter(Boolean)
	} catch {
		return []
	}
}

async function main() {
	const checkRemote = !process.argv.includes("--skip-remote")
	const baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined
	const pullRequest = await readPullRequestContext()
	const changedFiles = baseRef ? listChangedFiles(process.cwd(), baseRef) : []
	try {
		await validateRegistry(process.cwd(), { checkRemote, baseRef, pullRequest, changedFiles })
		console.log("Registry validation passed.")
	} catch (error) {
		if (error instanceof RegistryValidationError) {
			for (const issue of error.issues) console.error(`- ${issue}`)
			process.exitCode = 1
			return
		}
		throw error
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main()
}
