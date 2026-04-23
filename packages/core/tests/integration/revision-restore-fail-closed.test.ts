/**
 * Integration test: EmDashRuntime.handleRevisionRestore fails closed when
 * the collection capability lookup throws.
 *
 * Regression for a review finding: if `schemaRegistry.getCollectionWithFields()`
 * fails transiently (e.g. intermittent DB error), the dispatcher previously
 * caught the error and fell through to the legacy direct-write path, which
 * would overwrite live content on a collection that should route through the
 * draft revision workflow. That behavior lets a transient DB hiccup bypass
 * editorial review — so the dispatcher must instead return an error.
 *
 * This test calls the runtime's `handleRevisionRestore` method directly on a
 * minimal "this" with the two fields it touches (`db`, `schemaRegistry`),
 * stubs `getCollectionWithFields` to throw, and asserts that:
 *   1. the handler returns `{ success: false }` with `COLLECTION_LOOKUP_FAILED`, and
 *   2. live content is not overwritten.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// EmDashRuntime transitively imports adapter-provided virtual modules.
// Stub the ones it touches at module scope so the import graph resolves.
vi.mock(
	"virtual:emdash/config",
	() => ({
		default: {
			database: { config: { binding: "DB", session: "auto" } },
			auth: { mode: "none" },
		},
	}),
	{ virtual: true },
);
vi.mock(
	"virtual:emdash/dialect",
	() => ({
		createDialect: vi.fn(),
		createRequestScopedDb: vi.fn().mockReturnValue(null),
	}),
	{ virtual: true },
);
vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }), { virtual: true });
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }), { virtual: true });
vi.mock(
	"virtual:emdash/sandbox-runner",
	() => ({
		createSandboxRunner: null,
		sandboxEnabled: false,
	}),
	{ virtual: true },
);
vi.mock("virtual:emdash/sandboxed-plugins", () => ({ sandboxedPlugins: [] }), { virtual: true });
vi.mock("virtual:emdash/storage", () => ({ createStorage: null }), { virtual: true });
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });
vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }), { virtual: true });

import { ContentRepository } from "../../src/database/repositories/content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { EmDashRuntime } from "../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

describe("EmDashRuntime.handleRevisionRestore fails closed on capability lookup error", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;
	let contentRepo: ContentRepository;
	let revisionRepo: RevisionRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		contentRepo = new ContentRepository(db);
		revisionRepo = new RevisionRepository(db);

		await registry.createCollection({
			slug: "article",
			label: "Articles",
			labelSingular: "Article",
			supports: ["drafts", "revisions"],
		});
		await registry.createField("article", {
			slug: "title",
			label: "Title",
			type: "string",
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns COLLECTION_LOOKUP_FAILED when getCollectionWithFields throws", async () => {
		const article = await contentRepo.create({
			type: "article",
			slug: "live",
			data: { title: "Live headline" },
			status: "published",
		});
		const pastRevision = await revisionRepo.create({
			collection: "article",
			entryId: article.id,
			data: { title: "Older headline" },
		});

		// Stub schemaRegistry so the capability lookup throws. This simulates
		// a transient DB failure during `getCollectionWithFields`.
		const brokenRegistry = new SchemaRegistry(db);
		brokenRegistry.getCollectionWithFields = async () => {
			throw new Error("simulated transient DB failure");
		};

		// Invoke the runtime's dispatch method with a minimal `this`. This is
		// a focused contract test — we only exercise the single method, which
		// accesses `this.db` and `this.schemaRegistry`.
		const fakeThis = {
			db,
			schemaRegistry: brokenRegistry,
		} as unknown as EmDashRuntime;

		const result = await EmDashRuntime.prototype.handleRevisionRestore.call(
			fakeThis,
			pastRevision.id,
			"user_editor",
		);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("COLLECTION_LOOKUP_FAILED");

		// Crucially, live content must NOT have been overwritten. A fail-open
		// fallback would have routed through the legacy direct-write path and
		// replaced the live title with "Older headline".
		const live = await contentRepo.findById("article", article.id);
		expect(live?.data.title).toBe("Live headline");
	});

	it("returns NOT_FOUND for a missing revision without touching the schema registry", async () => {
		let lookupCalled = false;
		const brokenRegistry = new SchemaRegistry(db);
		brokenRegistry.getCollectionWithFields = async () => {
			lookupCalled = true;
			throw new Error("should not be called when revision is missing");
		};

		const fakeThis = {
			db,
			schemaRegistry: brokenRegistry,
		} as unknown as EmDashRuntime;

		const result = await EmDashRuntime.prototype.handleRevisionRestore.call(
			fakeThis,
			"nonexistent-revision-id",
			"user_editor",
		);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("NOT_FOUND");
		expect(lookupCalled).toBe(false);
	});
});
