import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	handleRevisionList,
	handleRevisionGet,
	handleRevisionRestore,
} from "../../../src/api/index.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import { createPostFixture } from "../../utils/fixtures.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("Revision Handlers", () => {
	let db: Kysely<Database>;
	let contentRepo: ContentRepository;
	let revisionRepo: RevisionRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		contentRepo = new ContentRepository(db);
		revisionRepo = new RevisionRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("handleRevisionList", () => {
		it("should return empty list when no revisions exist", async () => {
			const content = await contentRepo.create(createPostFixture());

			const result = await handleRevisionList(db, "post", content.id, {});

			expect(result.success).toBe(true);
			expect(result.data?.items).toEqual([]);
			expect(result.data?.total).toBe(0);
		});

		it("should return revisions for a content entry", async () => {
			const content = await contentRepo.create(createPostFixture());

			// Create some revisions with small delay to ensure distinct ULIDs
			await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "Version 1", content: "First version" },
			});
			// Small delay to ensure ULID timestamp differs
			await new Promise((resolve) => setTimeout(resolve, 2));
			await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "Version 2", content: "Second version" },
			});

			const result = await handleRevisionList(db, "post", content.id, {});

			expect(result.success).toBe(true);
			expect(result.data?.items).toHaveLength(2);
			expect(result.data?.total).toBe(2);
			// Should be newest first
			expect(result.data?.items[0].data.title).toBe("Version 2");
			expect(result.data?.items[1].data.title).toBe("Version 1");
		});

		it("should respect limit parameter", async () => {
			const content = await contentRepo.create(createPostFixture());

			// Create 5 revisions
			for (let i = 1; i <= 5; i++) {
				await revisionRepo.create({
					collection: "post",
					entryId: content.id,
					data: { title: `Version ${i}` },
				});
			}

			const result = await handleRevisionList(db, "post", content.id, {
				limit: 3,
			});

			expect(result.success).toBe(true);
			expect(result.data?.items).toHaveLength(3);
			expect(result.data?.total).toBe(5); // Total still reflects all revisions
		});

		it("should not return revisions from other entries", async () => {
			const content1 = await contentRepo.create(createPostFixture());
			const content2 = await contentRepo.create({
				...createPostFixture(),
				slug: "another-post",
			});

			await revisionRepo.create({
				collection: "post",
				entryId: content1.id,
				data: { title: "Content 1 revision" },
			});
			await revisionRepo.create({
				collection: "post",
				entryId: content2.id,
				data: { title: "Content 2 revision" },
			});

			const result = await handleRevisionList(db, "post", content1.id, {});

			expect(result.success).toBe(true);
			expect(result.data?.items).toHaveLength(1);
			expect(result.data?.items[0].data.title).toBe("Content 1 revision");
		});
	});

	describe("handleRevisionGet", () => {
		it("should return a revision by ID", async () => {
			const content = await contentRepo.create(createPostFixture());
			const revision = await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "Test Revision" },
			});

			const result = await handleRevisionGet(db, revision.id);

			expect(result.success).toBe(true);
			expect(result.data?.item.id).toBe(revision.id);
			expect(result.data?.item.data.title).toBe("Test Revision");
		});

		it("should return NOT_FOUND for non-existent revision", async () => {
			const result = await handleRevisionGet(db, "nonexistent-id");

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("NOT_FOUND");
		});
	});

	describe("handleRevisionRestore", () => {
		const callerUserId = "user_caller_123";

		it("should restore content to a previous revision", async () => {
			const content = await contentRepo.create({
				...createPostFixture(),
				data: { title: "Original", content: "Original content" },
			});

			// Create a revision with the original state
			const originalRevision = await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "Original", content: "Original content" },
			});

			// Update the content
			await contentRepo.update("post", content.id, {
				data: { title: "Updated", content: "Updated content" },
			});

			// Restore to original revision
			const result = await handleRevisionRestore(db, originalRevision.id, callerUserId);

			expect(result.success).toBe(true);
			expect(result.data?.item.data.title).toBe("Original");
			expect(result.data?.item.data.content).toBe("Original content");
		});

		it("should create a new revision when restoring", async () => {
			const content = await contentRepo.create(createPostFixture());

			const revision = await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "To restore" },
			});

			const beforeCount = await revisionRepo.countByEntry("post", content.id);

			await handleRevisionRestore(db, revision.id, callerUserId);

			const afterCount = await revisionRepo.countByEntry("post", content.id);
			expect(afterCount).toBe(beforeCount + 1);
		});

		it("should attribute the new revision to the caller", async () => {
			const content = await contentRepo.create(createPostFixture());

			const revision = await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "To restore" },
				authorId: "original_author",
			});

			await handleRevisionRestore(db, revision.id, callerUserId);

			// The newest revision (restore record) should be attributed to the caller
			const latestRevision = await revisionRepo.findLatest("post", content.id);
			expect(latestRevision).not.toBeNull();
			expect(latestRevision!.authorId).toBe(callerUserId);
		});

		it("should handle revision data containing _slug", async () => {
			const content = await contentRepo.create({
				...createPostFixture(),
				data: { title: "Original" },
			});

			// Revision data includes _slug (added by runtime when slug changes)
			const revision = await revisionRepo.create({
				collection: "post",
				entryId: content.id,
				data: { title: "With slug change", _slug: "new-slug" },
			});

			const result = await handleRevisionRestore(db, revision.id, callerUserId);

			expect(result.success).toBe(true);
			expect(result.data?.item.data.title).toBe("With slug change");
			expect(result.data?.item.slug).toBe("new-slug");
		});

		it("should return NOT_FOUND for non-existent revision", async () => {
			const result = await handleRevisionRestore(db, "nonexistent-id", callerUserId);

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("NOT_FOUND");
		});

		// -----------------------------------------------------------------
		// Draft-aware restore for collections with revision support
		//
		// When the collection has `supports: ["revisions"]`, restore must
		// NOT overwrite live content. Instead it stages the restored data
		// as a draft revision, preserving the existing editorial workflow
		// (restore -> review -> publish).
		// -----------------------------------------------------------------

		describe("with supportsRevisions = true", () => {
			it("does not overwrite live content columns on restore", async () => {
				const content = await contentRepo.create({
					...createPostFixture(),
					data: { title: "Live title", content: "Live content" },
				});

				// Create a revision snapshotting a different past state
				const pastRevision = await revisionRepo.create({
					collection: "post",
					entryId: content.id,
					data: { title: "Past title", content: "Past content" },
				});

				const result = await handleRevisionRestore(db, pastRevision.id, callerUserId, {
					supportsRevisions: true,
				});

				expect(result.success).toBe(true);

				// Live content columns must be unchanged
				const live = await contentRepo.findById("post", content.id);
				expect(live?.data.title).toBe("Live title");
				expect(live?.data.content).toBe("Live content");
			});

			it("creates a new draft revision with the restored data", async () => {
				const content = await contentRepo.create({
					...createPostFixture(),
					data: { title: "Live" },
				});
				const pastRevision = await revisionRepo.create({
					collection: "post",
					entryId: content.id,
					data: { title: "Past state", extra: "field" },
				});

				await handleRevisionRestore(db, pastRevision.id, callerUserId, {
					supportsRevisions: true,
				});

				const entry = await contentRepo.findById("post", content.id);
				expect(entry?.draftRevisionId).toBeTruthy();
				expect(entry?.draftRevisionId).not.toBe(pastRevision.id);

				const draftRev = await revisionRepo.findById(entry!.draftRevisionId!);
				expect(draftRev).not.toBeNull();
				expect(draftRev!.data.title).toBe("Past state");
				expect(draftRev!.data.extra).toBe("field");
			});

			it("attributes the new draft revision to the caller", async () => {
				const content = await contentRepo.create(createPostFixture());
				const pastRevision = await revisionRepo.create({
					collection: "post",
					entryId: content.id,
					data: { title: "Past" },
					authorId: "original_author",
				});

				await handleRevisionRestore(db, pastRevision.id, callerUserId, {
					supportsRevisions: true,
				});

				const entry = await contentRepo.findById("post", content.id);
				const draftRev = await revisionRepo.findById(entry!.draftRevisionId!);
				expect(draftRev!.authorId).toBe(callerUserId);
			});

			it("does not change the live slug even when revision carries _slug", async () => {
				const content = await contentRepo.create({
					...createPostFixture(),
					slug: "live-slug",
					data: { title: "Live" },
				});
				const pastRevision = await revisionRepo.create({
					collection: "post",
					entryId: content.id,
					data: { title: "Past", _slug: "past-slug" },
				});

				await handleRevisionRestore(db, pastRevision.id, callerUserId, {
					supportsRevisions: true,
				});

				const live = await contentRepo.findById("post", content.id);
				// Live slug must not change; slug rewrite must go through publish
				expect(live?.slug).toBe("live-slug");
			});

			it("returns NOT_FOUND for non-existent revision", async () => {
				const result = await handleRevisionRestore(db, "nonexistent-id", callerUserId, {
					supportsRevisions: true,
				});
				expect(result.success).toBe(false);
				expect(result.error?.code).toBe("NOT_FOUND");
			});
		});
	});
});
