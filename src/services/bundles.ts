import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  analyzeBundle,
  lastVerifiedAt,
  staleSince,
  trustTier,
  type Concept,
  type CoreBundle,
  type HealthReport,
} from "@lorsabyan/okf-core";
import { loadBundleFromDir } from "@lorsabyan/okf-core/node";

/**
 * Bundle loading, cached by resolved path.
 *
 * Every tool takes `bundle_path` rather than the server holding one "active"
 * bundle. Plan 009 sketched `load_bundle(dir)` followed by stateless calls
 * against implicit state, but that makes tool order load-bearing: an agent that
 * calls `search` first gets an error that teaches it nothing about the bundle it
 * actually wanted. Passing the path every time removes the ordering requirement,
 * and this cache removes the cost of doing so.
 */
const cache = new Map<string, CoreBundle>();

export class BundleError extends Error {}

/** Load a bundle, or throw a `BundleError` whose message tells the agent what to do. */
export function getBundle(bundlePath: string): CoreBundle {
  const dir = resolve(bundlePath);

  if (!existsSync(dir)) {
    throw new BundleError(
      `No such directory: ${dir}. Pass an absolute path to a directory of OKF markdown files, ` +
        `or a path relative to this server's working directory.`,
    );
  }
  if (!statSync(dir).isDirectory()) {
    throw new BundleError(
      `Not a directory: ${dir}. An OKF bundle is a directory of .md files, not a single file.`,
    );
  }

  const hit = cache.get(dir);
  if (hit) return hit;

  const bundle = loadBundleFromDir(dir);
  if (bundle.concepts.length === 0) {
    throw new BundleError(
      `${dir} contains no OKF concept documents. A bundle is a directory of .md files with YAML ` +
        `frontmatter; index.md and log.md are reserved and do not count as concepts.`,
    );
  }

  cache.set(dir, bundle);
  return bundle;
}

/** Drop cached bundles so a re-read picks up edits on disk. */
export function clearCache(bundlePath?: string): number {
  if (!bundlePath) {
    const n = cache.size;
    cache.clear();
    return n;
  }
  return cache.delete(resolve(bundlePath)) ? 1 : 0;
}

/** A concept's trust and lifecycle signals, the shape every tool reports them in. */
export interface ConceptSignals {
  status: Concept["status"];
  trust: ReturnType<typeof trustTier>;
  verified_by: string[];
  verified_at?: string;
  updated_at?: string;
  stale_since?: string;
}

/**
 * Trust and freshness for one concept (spec §5.3, §5.5).
 *
 * `now` is injectable so a caller can ask "what was stale on date X"; it also
 * keeps this testable without the answer changing as the clock moves.
 */
export function signalsFor(concept: Concept, now: Date = new Date()): ConceptSignals {
  const expired = staleSince(concept, now);
  const at = lastVerifiedAt(concept);
  return {
    status: concept.status,
    trust: trustTier(concept),
    verified_by: concept.verified.map((v) => v.by),
    ...(at ? { verified_at: at } : {}),
    ...(concept.updatedAt ? { updated_at: concept.updatedAt } : {}),
    ...(expired ? { stale_since: expired } : {}),
  };
}

/** A concept without its body — the shape list and search results return. */
export interface ConceptSummary extends ConceptSignals {
  id: string;
  title: string;
  type: string;
  description: string;
  tags: string[];
  resource?: string;
}

export function summarize(concept: Concept, now?: Date): ConceptSummary {
  return {
    id: concept.id,
    title: concept.title,
    type: concept.type,
    description: concept.description,
    tags: concept.tags,
    ...(concept.resource ? { resource: concept.resource } : {}),
    ...signalsFor(concept, now),
  };
}

export function healthOf(bundle: CoreBundle, now?: Date): HealthReport {
  return analyzeBundle(bundle, now);
}
