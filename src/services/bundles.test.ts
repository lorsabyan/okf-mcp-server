import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { BundleError, clearCache, getBundle, signalsFor, summarize } from "./bundles.js";

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function bundle(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "okf-mcp-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

const CONCEPT = [
  "---",
  "type: Metric",
  "title: Revenue",
  "description: Recognized revenue.",
  "generated: { by: human:x, at: 2026-07-01T00:00:00Z }",
  "verified: { by: human:reviewer, at: 2026-07-02T00:00:00Z }",
  "stale_after: 2026-12-31",
  "tags: [finance]",
  "---",
  "",
  "Body.",
].join("\n");

describe("getBundle", () => {
  test("loads a bundle from disk", () => {
    const dir = bundle({ "index.md": "# X\n\n* [R](revenue.md) - d\n", "revenue.md": CONCEPT });
    const b = getBundle(dir);
    assert.equal(b.concepts.length, 1);
    assert.equal(b.byId.get("revenue")?.title, "Revenue");
  });

  test("caches by resolved path, so a second call is the same object", () => {
    const dir = bundle({ "a.md": CONCEPT });
    assert.equal(getBundle(dir), getBundle(dir));
  });

  test("clearCache forces a re-read", () => {
    const dir = bundle({ "a.md": CONCEPT });
    const first = getBundle(dir);
    assert.equal(clearCache(dir), 1);
    assert.notEqual(getBundle(dir), first);
  });

  test("a missing directory names the path and says what to pass", () => {
    assert.throws(() => getBundle("/nope/missing"), (e: unknown) => {
      assert.ok(e instanceof BundleError);
      assert.match(e.message, /No such directory/);
      assert.match(e.message, /directory of OKF markdown files/);
      return true;
    });
  });

  test("a file rather than a directory explains what a bundle is", () => {
    const dir = bundle({ "a.md": CONCEPT });
    assert.throws(() => getBundle(join(dir, "a.md")), (e: unknown) => {
      assert.match((e as Error).message, /not a single file/);
      return true;
    });
  });

  test("a directory with no concepts explains reserved filenames", () => {
    // index.md and log.md are reserved, so this looks like a bundle and is not one.
    const dir = bundle({ "index.md": "# Only an index\n", "log.md": "# Log\n" });
    assert.throws(() => getBundle(dir), (e: unknown) => {
      assert.match((e as Error).message, /no OKF concept documents/);
      return true;
    });
  });
});

describe("signalsFor", () => {
  const dir = () => bundle({ "a.md": CONCEPT });

  test("derives the trust tier from verified (§5.3)", () => {
    const c = getBundle(dir()).byId.get("a")!;
    assert.equal(signalsFor(c).trust, "human-reviewed");
    assert.deepEqual(signalsFor(c).verified_by, ["human:reviewer"]);
  });

  test("staleness is evaluated against the injected date, not the clock", () => {
    const c = getBundle(dir()).byId.get("a")!;
    assert.equal(signalsFor(c, new Date("2026-07-30T00:00:00Z")).stale_since, undefined);
    assert.equal(signalsFor(c, new Date("2027-01-01T00:00:00Z")).stale_since, "2026-12-31");
  });

  test("the stale_after day itself counts as stale (§5.5 is inclusive)", () => {
    const c = getBundle(dir()).byId.get("a")!;
    assert.equal(signalsFor(c, new Date("2026-12-31T00:00:00Z")).stale_since, "2026-12-31");
  });

  test("an unverified concept reports the tier rather than omitting it", () => {
    const d = bundle({ "b.md": "---\ntype: Metric\ndescription: d\n---\n\nBody.\n" });
    const c = getBundle(d).byId.get("b")!;
    assert.equal(signalsFor(c).trust, "unverified");
    assert.deepEqual(signalsFor(c).verified_by, []);
  });
});

describe("summarize", () => {
  test("carries identity, classification, and signals but not the body", () => {
    const c = getBundle(bundle({ "a.md": CONCEPT })).byId.get("a")!;
    const s = summarize(c);
    assert.equal(s.id, "a");
    assert.equal(s.type, "Metric");
    assert.deepEqual(s.tags, ["finance"]);
    assert.equal(s.trust, "human-reviewed");
    assert.ok(!("body" in s), "summaries must stay cheap to list");
  });
});
