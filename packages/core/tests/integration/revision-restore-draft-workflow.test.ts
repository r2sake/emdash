/**
 * Integration test for revision restore + draft workflow.
 *
 * Regression for the "revision restore bypasses draft workflow" finding:
 * on a collection configured with `supports: ["revisions"]`, calling
 * `handleRevisionRestore` with `supportsRevisions: true` must stage the
 * restored data as a new draft revision instead of overwriting live content.
 *
 * This exercises the same wiring the runtime's `handleRevisionRestore`
 * performs (look up the collection's `supports` array, dispatch with the
 * correct flag) without requiring a full runtime boot.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRevisionRestore } from "../../src/api/handlers/revision.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

describe("revision restore respects draft workflow on revisioned collections", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;
	let contentRepo: ContentRepository;
	let revisionRepo: RevisionRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		contentRepo = new ContentRepository(db);
		revisionRepo = new RevisionRepository(db);

		// Create a collection that uses the draft revision workflow
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
		await registry.createField("article", {
			slug: "body",
			label: "Body",
			type: "text",
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	/**
	 * Mirrors the lookup the runtime performs before dispatching to the
	 * handler, exercised here as an integration probe so the whole path is
	 * covered end to end.
	 */
	async function getSupportsRevisions(collection: string): Promise<boolean> {
		const collectionInfo = await registry.getCollectionWithFields(collection);
		return collectionInfo?.supports?.includes("revisions") ?? false;
	}

	it("does not overwrite published content on restore", async () => {
		// Seed a published article
		const article = await contentRepo.create({
			type: "article",
			slug: "live",
			data: { title: "Live headline", body: "Live body" },
			status: "published",
		});

		// Snapshot an older state as a revision
		const pastRevision = await revisionRepo.create({
			collection: "article",
			entryId: article.id,
			data: { title: "Older headline", body: "Older body" },
		});

		// Dispatch with the same wiring the runtime uses
		const supportsRevisions = await getSupportsRevisions("article");
		expect(supportsRevisions).toBe(true);

		const result = await handleRevisionRestore(db, pastRevision.id, "user_editor", {
			supportsRevisions,
		});
		expect(result.success).toBe(true);

		// Live content must still be the "Live ..." state
		const live = await contentRepo.findById("article", article.id);
		expect(live?.data.title).toBe("Live headline");
		expect(live?.data.body).toBe("Live body");
		expect(live?.status).toBe("published");
	});

	it("stages the restored data on draft_revision_id", async () => {
		const article = await contentRepo.create({
			type: "article",
			slug: "staged",
			data: { title: "Current", body: "Current" },
			status: "published",
		});
		const pastRevision = await revisionRepo.create({
			collection: "article",
			entryId: article.id,
			data: { title: "Restored", body: "Restored" },
		});

		const supportsRevisions = await getSupportsRevisions("article");
		await handleRevisionRestore(db, pastRevision.id, "user_editor", { supportsRevisions });

		const entry = await contentRepo.findById("article", article.id);
		expect(entry?.draftRevisionId).toBeTruthy();
		expect(entry?.draftRevisionId).not.toBe(pastRevision.id);

		const draftRev = await revisionRepo.findById(entry!.draftRevisionId!);
		expect(draftRev?.data.title).toBe("Restored");
		expect(draftRev?.data.body).toBe("Restored");
		expect(draftRev?.authorId).toBe("user_editor");
	});

	it("non-revisioned collection still writes to live on restore", async () => {
		// Secondary collection without revision support
		await registry.createCollection({
			slug: "plain",
			label: "Plain",
			labelSingular: "Plain",
			supports: [],
		});
		await registry.createField("plain", { slug: "title", label: "Title", type: "string" });

		const entry = await contentRepo.create({
			type: "plain",
			slug: "p",
			data: { title: "Original" },
		});
		const rev = await revisionRepo.create({
			collection: "plain",
			entryId: entry.id,
			data: { title: "Restored" },
		});

		const supportsRevisions = await getSupportsRevisions("plain");
		expect(supportsRevisions).toBe(false);

		await handleRevisionRestore(db, rev.id, "user_editor", { supportsRevisions });

		const after = await contentRepo.findById("plain", entry.id);
		expect(after?.data.title).toBe("Restored");
	});
});
