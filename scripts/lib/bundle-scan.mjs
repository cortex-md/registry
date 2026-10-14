// Mirrors the static rules of `cortex check` (cortex-md/cli: internal/rules, internal/plugin/check.go).
// Bundles are only scanned as text; registry automation never executes third-party code.

export const PLUGIN_PERMISSIONS = new Set([
	"vault:read",
	"vault:write",
	"vault:delete",
	"vault:watch",
	"editor:read",
	"editor:write",
	"workspace:tabs",
	"theme:read",
	"bookmarks:read",
	"bookmarks:write",
	"data",
	"notifications",
])

export const RUNTIME_EXTERNALS = new Set(["@cortex.md/api", "@codemirror/state", "@codemirror/view"])

export const BUNDLE_SIZE_WARNING = 1024 * 1024
export const BUNDLE_SIZE_LIMIT = 5 * 1024 * 1024
export const STYLESHEET_SIZE_LIMIT = 200 * 1024

const BUNDLE_PATTERNS = [
	{ pattern: /\beval\s*\(/, level: "fail", message: "bundle calls eval()" },
	{ pattern: /new\s+Function\s*\(/, level: "fail", message: "bundle uses the Function constructor" },
	{ pattern: /dangerouslySetInnerHTML/, level: "warn", message: "bundle uses dangerouslySetInnerHTML" },
	{ pattern: /<script[^>]*>/i, level: "warn", message: "bundle contains an inline <script> tag" },
]

const REQUIRE_PATTERN = /require\(\s*["']([^"']+)["']\s*\)/g
const ESM_PATTERN = /^\s*(import\s.+from\s|export\s)/m
const REMOTE_URL_PATTERN = /url\s*\(\s*['"]?https?:\/\//i

export function scanPluginBundle(source) {
	const findings = []
	const size = Buffer.byteLength(source)

	if (size > BUNDLE_SIZE_LIMIT) {
		findings.push(fail(`bundle is ${toMegabytes(size)} MB (limit 5 MB)`))
	} else if (size > BUNDLE_SIZE_WARNING) {
		findings.push(warn(`bundle is ${toMegabytes(size)} MB`))
	}

	for (const check of BUNDLE_PATTERNS) {
		if (check.pattern.test(source)) findings.push({ level: check.level, message: check.message })
	}

	const unsupported = new Set()
	for (const match of source.matchAll(REQUIRE_PATTERN)) {
		if (!RUNTIME_EXTERNALS.has(match[1])) unsupported.add(match[1])
	}
	if (unsupported.size > 0) {
		findings.push(fail(`bundle requires modules Cortex does not provide: ${[...unsupported].sort().join(", ")}`))
	}

	if (ESM_PATTERN.test(source)) {
		findings.push(fail("bundle is an ES module; Cortex loads plugins as CommonJS"))
	}

	return findings
}

export function scanThemeStylesheet(name, source) {
	const findings = []
	if (Buffer.byteLength(source) > STYLESHEET_SIZE_LIMIT) findings.push(fail(`${name} is larger than 200 KB`))
	if (source.includes("@import")) findings.push(warn(`${name} uses @import`))
	if (REMOTE_URL_PATTERN.test(source)) findings.push(warn(`${name} loads remote URLs`))
	return findings
}

export function auditStatus(findings) {
	if (findings.some((finding) => finding.level === "fail")) return "fail"
	if (findings.some((finding) => finding.level === "warn")) return "warn"
	return "pass"
}

function fail(message) {
	return { level: "fail", message }
}

function warn(message) {
	return { level: "warn", message }
}

function toMegabytes(size) {
	return (size / 1024 / 1024).toFixed(1)
}
