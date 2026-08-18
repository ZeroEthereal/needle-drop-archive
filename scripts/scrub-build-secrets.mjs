import { readFile, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

const outputRoot = new URL("../dist/", import.meta.url);
const projectRoot = new URL("../", import.meta.url);

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const files = await filesUnder(outputRoot.pathname);
for (const path of files) {
  const name = basename(path);
  if (name === ".dev.vars" || name.startsWith(".dev.vars.") || name === ".env" || name.startsWith(".env.")) {
    await unlink(path);
  }
}

const localVars = await readFile(new URL(".dev.vars", projectRoot), "utf8").catch(() => "");
const secretValues = localVars
  .split(/\r?\n/)
  .map((line) => line.match(/^SESSION_ENCRYPTION_KEY=(.+)$/)?.[1]?.trim())
  .filter((value) => value && value.length >= 20);

for (const path of await filesUnder(outputRoot.pathname)) {
  const content = await readFile(path);
  for (const secret of secretValues) {
    if (content.includes(Buffer.from(secret))) {
      throw new Error(`Build artifact contains a local secret: ${path}`);
    }
  }
}

console.log("Build secret scrub passed");
