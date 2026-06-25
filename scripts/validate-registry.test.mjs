import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
	canonicalRegistryJson,
	validateCrossRegistryIds,
	validatePluginRelease,
	validateRegistryEntries,
	validateThemeRelease,
} from "./validate-registry.mjs"

const pluginEntry = {
	id: "sample-plugin",
	name: "Sample Plugin",
	author: "Cortex",
	description: "A sample plugin",
	coverImageUrl: "",
	repo: "cortex-md/sample-plugin",
}

const themeEntry = {
	id: "sample-theme",
	name: "Sample Theme",
	author: "Cortex",
	description: "A sample theme",
	coverImageUrl: "",
	repo: "cortex-md/sample-theme",
}

function releaseWithAssets(names) {
	return {
		tag_name: "v1.0.0",
		published_at: "2026-01-01T00:00:00Z",
		zipball_url: "https://api.github.com/repos/cortex-md/sample/zipball/v1.0.0",
		assets: names.map((name) => ({
			name,
			browser_download_url: `https://github.com/cortex-md/sample/releases/download/v1.0.0/${name}`,
		})),
	}
}

describe("registry entry validation", () => {
	it("canonicalizes entries by id and field order", () => {
		const source = [
			{
				repo: "cortex-md/zeta",
				coverImageUrl: "",
				description: "Zeta",
				author: "Cortex",
				name: "Zeta",
				id: "zeta",
			},
			{
				id: "alpha",
				name: "Alpha",
				author: "Cortex",
				description: "Alpha",
				coverImageUrl: "",
				repo: "cortex-md/alpha",
			},
		]

		assert.equal(
			canonicalRegistryJson(source),
			[
				"[",
				"\t{",
				'\t\t"id": "alpha",',
				'\t\t"name": "Alpha",',
				'\t\t"author": "Cortex",',
				'\t\t"description": "Alpha",',
				'\t\t"coverImageUrl": "",',
				'\t\t"repo": "cortex-md/alpha"',
				"\t},",
				"\t{",
				'\t\t"id": "zeta",',
				'\t\t"name": "Zeta",',
				'\t\t"author": "Cortex",',
				'\t\t"description": "Zeta",',
				'\t\t"coverImageUrl": "",',
				'\t\t"repo": "cortex-md/zeta"',
				"\t}",
				"]",
				"",
			].join("\n"),
		)
	})

	it("rejects unsorted entries", () => {
		const { issues } = validateRegistryEntries("plugin", [
			pluginEntry,
			{ ...pluginEntry, id: "alpha", repo: "cortex-md/alpha" },
		])

		assert.ok(issues.some((issue) => issue.includes("entries must be sorted by id")))
	})

	it("rejects duplicate ids and non-owner repo values", () => {
		const { issues } = validateRegistryEntries("plugin", [
			pluginEntry,
			{ ...pluginEntry, id: "alpha", repo: "https://github.com/cortex-md/alpha" },
			{ ...pluginEntry },
		])

		assert.ok(issues.some((issue) => issue.includes('duplicate id "sample-plugin"')))
		assert.ok(issues.some((issue) => issue.includes("repo must use owner/repo format")))
	})

	it("rejects ids reused across plugins and themes", () => {
		const issues = validateCrossRegistryIds([
			{ kind: "plugin", entries: [pluginEntry] },
			{ kind: "theme", entries: [{ ...themeEntry, id: pluginEntry.id }] },
		])

		assert.deepEqual(issues, ['id "sample-plugin" is declared as both plugin and theme'])
	})
})

describe("release asset validation", () => {
	it("accepts a plugin main asset by basename to match the installer fallback", () => {
		const issues = validatePluginRelease(
			pluginEntry,
			releaseWithAssets(["manifest.json", "index.js"]),
			JSON.stringify({
				id: pluginEntry.id,
				name: pluginEntry.name,
				version: "1.0.0",
				minAppVersion: "0.1.0",
				author: pluginEntry.author,
				description: pluginEntry.description,
				icon: "puzzle",
				main: "dist/index.js",
				capabilities: [],
			}),
		)

		assert.deepEqual(issues, [])
	})

	it("rejects plugin styles without the markdown extension capability", () => {
		const issues = validatePluginRelease(
			pluginEntry,
			releaseWithAssets(["manifest.json", "main.js", "styles.css"]),
			JSON.stringify({
				id: pluginEntry.id,
				name: pluginEntry.name,
				version: "1.0.0",
				minAppVersion: "0.1.0",
				author: pluginEntry.author,
				description: pluginEntry.description,
				icon: "puzzle",
				main: "main.js",
				capabilities: [],
			}),
		)

		assert.ok(issues.some((issue) => issue.includes('styles.css requires the "markdown:extensions"')))
	})

	it("accepts theme stylesheet assets by colorscheme fallback names", () => {
		const issues = validateThemeRelease(
			themeEntry,
			releaseWithAssets(["manifest.json", "dark.css", "light.css"]),
			JSON.stringify({
				id: themeEntry.id,
				name: "sample-theme",
				displayName: themeEntry.name,
				author: themeEntry.author,
				version: "1.0.0",
				colorschemes: {
					dark: "dist/theme-dark.css",
					light: "dist/theme-light.css",
				},
			}),
		)

		assert.deepEqual(issues, [])
	})
})
