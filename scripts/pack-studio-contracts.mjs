import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const output = resolve(args[args.indexOf("--out") + 1] ?? join(root, ".artifacts/studio-contracts"));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "livi-contract-handoff-"));
const run = (program, argv, cwd = root) =>
	execFileSync(program, argv, {
		cwd,
		stdio: "inherit",
		env: { ...process.env, npm_config_cache: join(temporary, "npm-cache") },
	});
for (const name of ["@earendil-works/chord", "@earendil-works/pi-protocol", "@earendil-works/pi-client"]) {
	run("pnpm", ["--filter", name, "build"]);
	run("pnpm", ["--filter", name, "pack", "--pack-destination", output]);
}
const version = JSON.parse(await readFile(join(root, "packages/decorator-agent/package.json"), "utf8")).version;
const packageDirectory = join(temporary, "package");
await mkdir(packageDirectory);
run("pnpm", [
	"exec",
	"tsc",
	"--target",
	"es2022",
	"--module",
	"nodenext",
	"--skipLibCheck",
	"--declaration",
	"--outDir",
	packageDirectory,
	"packages/decorator-agent/src/services/studio.ts",
]);
await writeFile(
	join(packageDirectory, "package.json"),
	JSON.stringify(
		{
			name: "@livi/studio-contracts",
			version,
			type: "module",
			files: ["studio.js", "studio.d.ts"],
			exports: { ".": { types: "./studio.d.ts", import: "./studio.js" } },
			dependencies: { "@earendil-works/chord": "0.85.1" },
		},
		null,
		2,
	),
);
run("npm", ["pack", "--pack-destination", output], packageDirectory);
// Include installed external runtime dependencies, so the consumer needs no workspace or registry.
for (const name of ["typebox", "esbuild"]) {
	const dependency =
		name === "typebox" ? "packages/protocol/node_modules/typebox" : "packages/chord/node_modules/esbuild";
	run("npm", ["pack", "--ignore-scripts", "--pack-destination", output], join(root, dependency));
}
const tarballs = [
	`livi-studio-contracts-${version}.tgz`,
	"earendil-works-chord-0.85.1.tgz",
	"earendil-works-pi-protocol-0.85.1.tgz",
	"earendil-works-pi-client-0.85.1.tgz",
	"typebox-1.3.7.tgz",
	"esbuild-0.28.1.tgz",
];
const consumer = join(temporary, "consumer");
await mkdir(consumer);
await writeFile(
	join(consumer, "package.json"),
	JSON.stringify({ name: "studio-external-consumer", private: true, type: "module" }),
);
run(
	"npm",
	[
		"install",
		"--offline",
		"--ignore-scripts",
		"--omit=optional",
		"--no-audit",
		"--no-fund",
		"--package-lock=false",
		...tarballs.map((name) => join(output, name)),
	],
	consumer,
);
await cp(join(root, "scripts/fixtures/studio/consumer.ts"), join(consumer, "consumer.ts"));
run("pnpm", [
	"exec",
	"tsc",
	"--strict",
	"--skipLibCheck",
	"--target",
	"es2022",
	"--module",
	"nodenext",
	"--lib",
	"es2022,dom",
	"--outDir",
	join(consumer, "dist"),
	join(consumer, "consumer.ts"),
]);
const { build } = await import("../packages/chord/node_modules/esbuild/lib/main.js");
await build({
	entryPoints: [join(consumer, "consumer.ts")],
	outfile: join(consumer, "browser.js"),
	bundle: true,
	platform: "browser",
	format: "esm",
});
run("node", [join(consumer, "dist/consumer.js")], consumer);
await writeFile(
	join(output, "handoff.json"),
	JSON.stringify(
		{
			version,
			tarballs,
			isolatedConsumer: consumer,
			typescript: "passed",
			browserBundle: "passed",
			runtimeImport: "passed",
		},
		null,
		2,
	),
);
console.log(`Verified isolated Studio contract consumer. Tarballs and evidence: ${output}`);
