/**
 * Revision history handlers
 */

import type { Kysely } from "kysely";

import { ContentRepository } from "../../database/repositories/content.js";
import { RevisionRepository, type Revision } from "../../database/repositories/revision.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database } from "../../database/types.js";
import type { ApiResult, ContentResponse } from "../types.js";

/**
 * Sentinel thrown inside the draft-aware restore transaction when the
 * target content row is missing or soft-deleted. Used to roll back the
 * just-created draft revision so we don't leave an orphan behind.
 */
class ContentNotFoundForRestoreError extends Error {
	constructor() {
		super("Content item not found for revision restore");
		this.name = "ContentNotFoundForRestoreError";
	}
}

export interface RevisionListResponse {
	items: Revision[];
	total: number;
}

export interface RevisionResponse {
	item: Revision;
}

/**
 * List revisions for a content entry
 */
export async function handleRevisionList(
	db: Kysely<Database>,
	collection: string,
	entryId: string,
	params: { limit?: number } = {},
): Promise<ApiResult<RevisionListResponse>> {
	try {
		const repo = new RevisionRepository(db);
		const [items, total] = await Promise.all([
			repo.findByEntry(collection, entryId, { limit: Math.min(params.limit || 50, 100) }),
			repo.countByEntry(collection, entryId),
		]);

		return {
			success: true,
			data: { items, total },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "REVISION_LIST_ERROR",
				message: "Failed to list revisions",
			},
		};
	}
}

/**
 * Get a specific revision
 */
export async function handleRevisionGet(
	db: Kysely<Database>,
	revisionId: string,
): Promise<ApiResult<RevisionResponse>> {
	try {
		const repo = new RevisionRepository(db);
		const item = await repo.findById(revisionId);

		if (!item) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Revision not found: ${revisionId}`,
				},
			};
		}

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "REVISION_GET_ERROR",
				message: "Failed to get revision",
			},
		};
	}
}

/**
 * Restore a revision.
 *
 * Behavior depends on whether the collection has revision support:
 *
 * - `supportsRevisions: false` (default) — Writes the revision's data
 *   directly into the live content table, matching the "edit immediately
 *   goes live" semantics of collections without draft revisions.
 *
 * - `supportsRevisions: true` — Stages the restored data as a draft
 *   revision and points the entry's `draft_revision_id` at it. Live
 *   content columns are left untouched so the restore still has to go
 *   through the normal publish workflow before it's visible. This
 *   mirrors how `handleContentUpdate` treats revisioned collections
 *   and prevents restore from bypassing editorial review.
 */
export async function handleRevisionRestore(
	db: Kysely<Database>,
	revisionId: string,
	callerUserId: string,
	options: { supportsRevisions?: boolean } = {},
): Promise<ApiResult<ContentResponse>> {
	try {
		const revisionRepo = new RevisionRepository(db);
		const contentRepo = new ContentRepository(db);

		// Get the revision
		const revision = await revisionRepo.findById(revisionId);
		if (!revision) {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `Revision not found: ${revisionId}`,
				},
			};
		}

		if (options.supportsRevisions) {
			// Draft-aware path: stage the restored data as a new draft revision.
			// Do NOT update live content columns — the restore must go through
			// publish, just like any other edit on a revisioned collection.
			//
			// Wrap the create-revision + update-draft-pointer in a transaction
			// so that if the content row is missing or soft-deleted, we don't
			// leave an orphan `revisions` row pointing at a non-existent entry.
			// `ContentRepository.setDraftRevision` validates entry existence
			// and throws when the row is missing, which rolls back the
			// just-inserted revision inside the transaction.
			try {
				await withTransaction(db, async (trx) => {
					const trxRevisionRepo = new RevisionRepository(trx);
					const trxContentRepo = new ContentRepository(trx);

					// Re-check the content row exists up-front inside the
					// transaction so we fail before inserting the revision.
					// This gives a clean NOT_FOUND path without relying on
					// transaction rollback (which is a no-op on D1 — see
					// `withTransaction` docs).
					const existing = await trxContentRepo.findById(revision.collection, revision.entryId);
					if (!existing) {
						throw new ContentNotFoundForRestoreError();
					}

					const draftRevision = await trxRevisionRepo.create({
						collection: revision.collection,
						entryId: revision.entryId,
						data: revision.data,
						authorId: callerUserId,
					});

					await trxContentRepo.setDraftRevision(
						revision.collection,
						revision.entryId,
						draftRevision.id,
					);
				});
			} catch (error) {
				if (error instanceof ContentNotFoundForRestoreError) {
					return {
						success: false,
						error: {
							code: "NOT_FOUND",
							message: `Content item not found: ${revision.entryId}`,
						},
					};
				}
				throw error;
			}

			// Fire-and-forget: prune old revisions to prevent unbounded growth
			void revisionRepo
				.pruneOldRevisions(revision.collection, revision.entryId, 50)
				.catch(() => {});

			const item = await contentRepo.findById(revision.collection, revision.entryId);
			if (!item) {
				// Content was soft-deleted between the transaction and this
				// read. Return NOT_FOUND so callers get a consistent response.
				return {
					success: false,
					error: {
						code: "NOT_FOUND",
						message: `Content item not found: ${revision.entryId}`,
					},
				};
			}

			return {
				success: true,
				data: { item },
			};
		}

		// Legacy path: collection does not support revisions. A restore is
		// equivalent to an edit that goes live immediately. Preserved for
		// backwards compatibility with non-revisioned collections.
		const { _slug, ...fieldData } = revision.data;

		const item = await contentRepo.update(revision.collection, revision.entryId, {
			data: fieldData,
			slug: typeof _slug === "string" ? _slug : undefined,
		});

		// Create a new revision to record the restore, attributed to the caller
		await revisionRepo.create({
			collection: revision.collection,
			entryId: revision.entryId,
			data: revision.data,
			authorId: callerUserId,
		});

		// Fire-and-forget: prune old revisions to prevent unbounded growth
		void revisionRepo.pruneOldRevisions(revision.collection, revision.entryId, 50).catch(() => {});

		return {
			success: true,
			data: { item },
		};
	} catch {
		return {
			success: false,
			error: {
				code: "REVISION_RESTORE_ERROR",
				message: "Failed to restore revision",
			},
		};
	}
}
