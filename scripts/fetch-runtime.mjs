import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const provenance = JSON.parse(await readFile(join(root, "runtime-provenance.json"), "utf8"));
const url = new URL(provenance.tarball);
if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org") throw new Error("Unexpected runtime publication source");
const temporary = await mkdtemp(join(tmpdir(), "t3-runtime-download-"));
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Runtime download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== provenance.integrity) throw new Error("Runtime integrity verification failed");
  const archive = join(temporary, "runtime.tgz");
  await writeFile(archive, bytes, { mode: 0o600 });
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 1024 * 1024 }).trim().split("\n");
  if (entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) throw new Error("Unsafe runtime archive path");
  const destination = join(root, "vendor");
  await mkdir(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", destination, "--strip-components=2", "package/vendor"]);
  console.log(JSON.stringify({ version: provenance.version, platform: provenance.platform, integrityVerified: true }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
