// Section 8.3 of OPERATOR_PROCEDURE_3159e52.md: before the captured index.html is restored, every captured file (every asset it references) is checked against the bucket and restored if missing or different.
// The bash block between the "web-rollback-asset-check" markers is extracted from the document and run against a FAKE aws whose "bucket" is a directory. No AWS, no network.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const doc = readFileSync(resolve(__dirname, "../../../docs/releases/2026-10-18-interface-simplification/OPERATOR_PROCEDURE_3159e52.md"), "utf8");
const block = /# web-rollback-asset-check\n([\s\S]*?)# end web-rollback-asset-check/.exec(doc)?.[1] ?? "";

const FAKE_AWS = `#!/usr/bin/env bash
echo "$*" >> "$MOCK_DIR/aws-calls.log"
if [[ "$1 $2" == "s3api head-object" ]]; then
  key=""; while [[ $# -gt 0 ]]; do [[ "$1" == "--key" ]] && key="$2"; shift; done
  f="$MOCK_DIR/bucket/$key"; [[ -f "$f" ]] && { wc -c < "$f" | tr -d ' '; exit 0; } || { echo "An error occurred (404) when calling the HeadObject operation" >&2; exit 254; }
fi
if [[ "$1 $2" == "s3 cp" ]]; then
  src="$3"; dest="\${4#s3://*/}"; mkdir -p "$(dirname "$MOCK_DIR/bucket/$dest")"; cp "$src" "$MOCK_DIR/bucket/$dest"; exit 0
fi
echo "unexpected aws call: $*" >&2; exit 99
`;

let dir: string;
const put = (root: string, rel: string, body: string) => { mkdirSync(join(dir, root, rel, ".."), { recursive: true }); writeFileSync(join(dir, root, rel), body); };
const run = () => {
  writeFileSync(join(dir, "check.sh"), `set -u\nBUCKET=test-bucket\n${block}`);
  const r = spawnSync("bash", [join(dir, "check.sh")], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, MOCK_DIR: dir } });
  return { out: (r.stdout ?? "") + (r.stderr ?? ""), code: r.status };
};
const calls = () => (existsSync(join(dir, "aws-calls.log")) ? readFileSync(join(dir, "aws-calls.log"), "utf8").split("\n").filter(Boolean) : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "webroll-"));
  mkdirSync(join(dir, "bin")); writeFileSync(join(dir, "bin", "aws"), FAKE_AWS); chmodSync(join(dir, "bin", "aws"), 0o755);
  put("web-before", "index.html", '<script type="module" src="/assets/index-AAAA1111.js"></script><link rel="stylesheet" href="/assets/index-BBBB2222.css">');
  put("web-before", "assets/index-AAAA1111.js", "console.log('old main')");
  put("web-before", "assets/index-BBBB2222.css", "body{}");
  put("web-before", "assets/chunk-CCCC3333.js", "export default 1");
  put("web-before", "config.json", '{"live":"config"}');
  // the bucket after the new deployment: old assets still present (nothing is deleted), new ones added, index.html is the new one
  put("bucket", "assets/index-AAAA1111.js", "console.log('old main')");
  put("bucket", "assets/index-BBBB2222.css", "body{}");
  put("bucket", "assets/chunk-CCCC3333.js", "export default 1");
  put("bucket", "assets/index-NEW99999.js", "console.log('new')");
  put("bucket", "index.html", "NEW INDEX");
  put("bucket", "config.json", '{"live":"config"}');
});

describe("web rollback: the captured assets are verified (and repaired) before index.html is restored", () => {
  it("the block exists in the procedure and contains nothing destructive", () => {
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toMatch(/--delete|s3 rm|s3 sync|rm -r|s3api delete|put-bucket|lifecycle/);
    expect(doc.indexOf("web-rollback-asset-check")).toBeLessThan(doc.indexOf('aws s3 cp web-before/index.html "s3://$BUCKET/index.html"'));
  });

  it("normal case: every captured file is in the bucket with the same size: nothing is restored, nothing is written", () => {
    const r = run();
    expect(r.out).toContain("files to restore from the capture: 0");
    expect(r.out).not.toContain("STOP:");
    expect(calls().filter((c) => c.startsWith("s3 cp"))).toEqual([]);
  });

  it("an asset the captured index.html references is missing from the bucket: it is restored from the capture with the immutable cache header, and nothing is deleted", () => {
    spawnSync("rm", [join(dir, "bucket/assets/index-AAAA1111.js")]);
    const r = run();
    expect(r.out).toContain("files to restore from the capture: 1");
    expect(r.out).toContain("restored assets/index-AAAA1111.js");
    expect(readFileSync(join(dir, "bucket/assets/index-AAAA1111.js"), "utf8")).toBe("console.log('old main')");
    const cp = calls().filter((c) => c.startsWith("s3 cp"));
    expect(cp).toHaveLength(1);
    expect(cp[0]).toContain("--cache-control public,max-age=31536000,immutable");
    expect(existsSync(join(dir, "bucket/assets/index-NEW99999.js"))).toBe(true);
    expect(calls().some((c) => /delete|rm |sync/.test(c))).toBe(false);
  });

  it("an asset present in the bucket with a different size (overwritten) is restored too", () => {
    writeFileSync(join(dir, "bucket/assets/chunk-CCCC3333.js"), "export default 'changed and longer'");
    const r = run();
    expect(r.out).toContain("restored assets/chunk-CCCC3333.js");
    expect(readFileSync(join(dir, "bucket/assets/chunk-CCCC3333.js"), "utf8")).toBe("export default 1");
  });

  it("index.html and config.json are never in the restore list, even when they differ from the bucket", () => {
    writeFileSync(join(dir, "bucket/config.json"), "different config, different size");
    const r = run();
    expect(r.out).toContain("files to restore from the capture: 0");
    expect(readFileSync(join(dir, "bucket/config.json"), "utf8")).toBe("different config, different size");
    expect(readFileSync(join(dir, "bucket/index.html"), "utf8")).toBe("NEW INDEX");
  });

  it("an asset the captured index.html references that is not in the capture itself stops the restore with a STOP line", () => {
    spawnSync("rm", [join(dir, "web-before/assets/index-BBBB2222.css")]);
    const r = run();
    expect(r.out).toContain("STOP: assets/index-BBBB2222.css is referenced by the captured index.html but is not in the capture");
  });
});
