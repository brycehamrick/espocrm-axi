#!/usr/bin/env node
// Guards skill drift: the SKILL.md frontmatter name must equal the package
// name (the `skills` CLI keys on it) and every registered command must be
// mentioned as `espocrm-axi <command>` so agents can discover it from the skill.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const skillPath = resolve(root, "skills", pkg.name, "SKILL.md");
const skill = readFileSync(skillPath, "utf8");

const problems = [];
const name = /^---\n[\s\S]*?^name:\s*(\S+)\s*$/m.exec(skill)?.[1];
if (name !== pkg.name) problems.push(`SKILL.md frontmatter name is ${JSON.stringify(name)}, package is ${pkg.name}`);
if (!/^description:\s*(.+)$/m.test(skill)) problems.push("SKILL.md has no description");
for (const section of ["## When to use", "## Auth", "## Invocation", "## Conventions"]) {
  if (!skill.includes(section)) problems.push(`SKILL.md missing section "${section}"`);
}

const { COMMAND_NAMES } = await import(resolve(root, "dist", "command-help.js"));
const bin = pkg.bin[pkg.name];
if (bin !== `bin/${pkg.name}.js`) problems.push(`package.json bin should be bin/${pkg.name}.js`);
for (const command of COMMAND_NAMES) {
  if (!skill.includes(`${pkg.name} ${command}`)) problems.push(`SKILL.md never mentions \`${pkg.name} ${command}\``);
}

if (problems.length > 0) {
  console.error(`skill check failed (${skillPath}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`skill check ok: ${COMMAND_NAMES.length} commands documented in skills/${pkg.name}/SKILL.md`);
