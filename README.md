# Cortex Registry

Public registry consumed by Cortex Marketplace.

## Registry Files

- `plugins.json` lists installable community plugins.
- `themes.json` lists installable community themes.

Both files are flat JSON arrays sorted by `id`.

```json
[
	{
		"id": "example-plugin",
		"name": "Example Plugin",
		"author": "Cortex",
		"authorUrl": "https://example.com",
		"description": "Adds an example command.",
		"coverImageUrl": "https://example.com/cover.png",
		"screenshots": [
			"https://raw.githubusercontent.com/owner/example-plugin/main/screenshots/editor.png"
		],
		"repo": "owner/example-plugin"
	}
]
```

Required fields: `id`, `name`, `author`, `description`, `coverImageUrl`, and `repo`.
`authorUrl` and `screenshots` are optional. `repo` must use GitHub `owner/repo` format.

`screenshots` lists 1 to 6 https URLs to `.png`, `.jpg`, `.webp` or `.gif` images, shown in this
order on the Marketplace page of the item in Cortex and on the website. Keep the images in the
item's repository (for example `screenshots/*.png` on `main`) and set them with `screenshots` in
`manifest.json` before running `cortex submit`.

## How to submit

Use the Cortex CLI from the plugin or theme repository:

```bash
cortex release patch   # publishes the GitHub release through the scaffolded workflow
cortex submit          # checks the release and opens or updates this pull request from your fork
```

Entries carry no version: Cortex always installs the latest GitHub release of `repo`. Submit again
only when the name, author, description, cover image or screenshots change.

## Release Requirements

Each listed repository must be public, have `README.md` on `main` or `master`, and expose a latest
GitHub release whose tag is `v<manifest.version>` (or `<manifest.version>`). Versions are plain
`MAJOR.MINOR.PATCH`; pre-release suffixes break update checks in the app.

Plugin releases must include:

- `manifest.json` whose `id` matches the entry
- the bundle asset named by `manifest.main`, or an asset with the same basename
- optional `styles.css` (Cortex only loads it for plugins with markdown contributions)

`manifest.permissions` (mirrored in `manifest.capabilities`) may only contain `vault:read`,
`vault:write`, `vault:delete`, `vault:watch`, `editor:read`, `editor:write`, `workspace:tabs`,
`theme:read`, `bookmarks:read`, `bookmarks:write`, `data` and `notifications`.

Theme releases must include:

- `manifest.json` whose `id` and `name` both match the entry id
- the dark and light stylesheet assets referenced by `manifest.colorschemes`

## Votes, downloads and stats

Generated data lives on the `data` branch, never on `main` (`stats.json` is gitignored there). The
workflows restore it from `data`, update it and push it back:

```text
https://raw.githubusercontent.com/cortex-md/registry/data/stats.json
```

```json
{
	"generatedAt": "2026-10-14T00:00:00.000Z",
	"plugins": {
		"example-plugin": {
			"downloads": 120,
			"stars": 8,
			"votes": 14,
			"latest": "1.2.0",
			"releasedAt": "2026-10-01T12:00:00Z",
			"discussion": { "number": 12, "nodeId": "D_...", "url": "https://github.com/cortex-md/registry/discussions/12" },
			"audit": { "status": "pass", "checkedTag": "v1.2.0", "checkedAt": "...", "issues": [] }
		}
	},
	"themes": {}
}
```

| Field | Source | Refresh |
| --- | --- | --- |
| `votes` | Upvotes on the item's Discussion (`Plugins` / `Themes` categories); reactions and comments do not count | every 30 min |
| `downloads` | `download_count` of the bundle asset (themes: the most downloaded stylesheet) summed over every release; never decreases | every 6 h |
| `stars`, `latest`, `releasedAt` | the item's repository and latest release | every 6 h |
| `audit` | static scan of the latest release, mirroring `cortex check` | daily |
| `discussion` | created when an entry is merged, locked when it is removed, recreated if it is deleted | on merge and daily |

Downloads include updates. Installs from the source-archive fallback are not counted.

## Verified and blocked items

Only maintainers change these files.

- `verified.json`: `[{ "kind", "id", "since" }]`. Cortex shows a verified badge.
- `blocked.json`: `[{ "kind", "id", "repo", "reason", "versions", "since" }]`. `versions: null`
  hides the whole item and its id can never be reused by another repository; a list hides only
  those versions and stops Cortex from offering them as updates. Installed copies are never
  removed automatically; Cortex asks the user to disable them.

The daily audit opens an `audit` issue and a pull request proposing a block when a release fails.
A maintainer merges it or closes it as a false positive; a closed proposal is not reopened for the
same version. One failing item never stops the audit of the others, and the audit result is
published to `stats.json` even when some items could not be checked.

## Ownership

When a pull request adds an entry or changes its `repo`, the author must own the repository or be
a public member of the owning organization. Otherwise the `review/ownership` label asks for a
manual check.

## Maintainer setup

1. Enable Discussions and create the `Plugins` and `Themes` categories in **Announcement** format,
   so only maintainers and automation can open topics while everyone can upvote and comment.
2. In Settings → Actions → General, allow GitHub Actions to create pull requests (used by the
   audit).
3. Make maintainer memberships of the organization public. Pull request checks read the author
   association and the ownership check reads public membership.
4. Protect `main` as described in [docs/branch-protection.md](docs/branch-protection.md). Leave
   `data` unprotected so the workflows can push `stats.json`.
5. Run the `Marketplace Discussions` workflow once to create the existing discussions.

## Validation

Run the same checks used by PR review:

```bash
node --test scripts/*.test.mjs
GITHUB_TOKEN=<token> node scripts/validate-registry.mjs
```

In pull requests only new or changed entries are checked against GitHub; schema and formatting
checks always cover every entry. Use `node scripts/validate-registry.mjs --skip-remote` for local
schema and formatting checks only.
