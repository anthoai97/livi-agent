import { execFileSync } from "node:child_process";

const stagedFiles = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], { encoding: "utf8" }).split("\0");
if (!stagedFiles.includes("pnpm-lock.yaml")) process.exit(0);

if (["1", "true", "yes"].includes(process.env.LIVI_ALLOW_LOCKFILE_CHANGE)) {
	console.log("pnpm-lock.yaml is staged; LIVI_ALLOW_LOCKFILE_CHANGE allows this commit.");
	process.exit(0);
}

// pnpm keeps workspace metadata in importers; resolutions live in other sections.
function resolutions(ref) {
	const content = execFileSync("git", ["show", ref], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	let inImporters = false;
	return content
		.split("\n")
		.filter((line) => {
			if (/^[a-zA-Z]/.test(line)) inImporters = line.startsWith("importers:");
			return !inImporters;
		})
		.join("\n");
}

try {
	if (resolutions("HEAD:pnpm-lock.yaml") === resolutions(":pnpm-lock.yaml")) {
		console.log("pnpm-lock.yaml only updates workspace metadata; allowing commit.");
		process.exit(0);
	}
} catch {
	// New or deleted lockfiles also need an explicit acknowledgement.
}

console.error("pnpm-lock.yaml changes dependency resolutions. Review the staged lockfile diff.");
console.error("If intentional, commit with LIVI_ALLOW_LOCKFILE_CHANGE=1 git commit ...");
process.exit(1);
