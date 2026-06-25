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
		"repo": "owner/example-plugin"
	}
]
```

Required fields: `id`, `name`, `author`, `description`, `coverImageUrl`, and `repo`.
`authorUrl` is optional. `repo` must use GitHub `owner/repo` format.

## Release Requirements

Each listed repository must expose a public latest GitHub release.

Plugin releases must include:

- `manifest.json`
- the bundle asset named by `manifest.main`, or an asset with the same basename
- optional `styles.css`; if present, `manifest.capabilities` must include `markdown:extensions`

Theme releases must include:

- `manifest.json`
- the dark and light stylesheet assets referenced by `manifest.colorschemes`

## Validation

Run the same checks used by PR review:

```bash
node --test scripts/*.test.mjs
GITHUB_TOKEN=<token> node scripts/validate-registry.mjs
```

Use `node scripts/validate-registry.mjs --skip-remote` for local schema and formatting checks only.
