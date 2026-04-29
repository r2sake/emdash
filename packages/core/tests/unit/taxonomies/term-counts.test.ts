import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
}));

import { getDb } from "../../../src/loader.js";
import { getTaxonomyTerms, getTerm, invalidateTermCache } from "../../../src/taxonomies/index.js";

describe("taxonomy term counts (#581)", () => {
	let db: Kysely<Database>;
	let taxRepo: TaxonomyRepository;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		taxRepo = new TaxonomyRepository(db);
		contentRepo = new ContentRepository(db);
		vi.mocked(getDb).mockResolvedValue(db);
		invalidateTermCache();

		// The setupTestDatabaseWithCollections helper creates a singular
		// `post` collection while the seeded `category` taxonomy points at
		// `posts` (plural). Re-target it so attachments to the test
		// collection are counted.
		await db
			.updateTable("_emdash_taxonomy_defs")
			.set({ collections: JSON.stringify(["post"]) })
			.where("name", "=", "category")
			.execute();
	});

	afterEach(async () => {
		invalidateTermCache();
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("excludes draft entries from getTaxonomyTerms counts", async () => {
		const term = await taxRepo.create({ name: "category", slug: "tech", label: "Tech" });

		const published = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
			status: "published",
		});
		const draft = await contentRepo.create({
			type: "post",
			slug: "p2",
			data: { title: "P2" },
			status: "draft",
		});

		await taxRepo.attachToEntry("post", published.id, term.id);
		await taxRepo.attachToEntry("post", draft.id, term.id);

		const terms = await getTaxonomyTerms("category");
		const tech = terms.find((t) => t.slug === "tech");
		expect(tech?.count).toBe(1);
	});

	it("excludes draft entries from getTerm count", async () => {
		const term = await taxRepo.create({ name: "category", slug: "tech", label: "Tech" });

		const published = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
			status: "published",
		});
		const draft = await contentRepo.create({
			type: "post",
			slug: "p2",
			data: { title: "P2" },
			status: "draft",
		});

		await taxRepo.attachToEntry("post", published.id, term.id);
		await taxRepo.attachToEntry("post", draft.id, term.id);

		const single = await getTerm("category", "tech");
		expect(single?.count).toBe(1);
	});

	it("excludes soft-deleted entries from term counts", async () => {
		const term = await taxRepo.create({ name: "category", slug: "news", label: "News" });

		const live = await contentRepo.create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
			status: "published",
		});
		const trashed = await contentRepo.create({
			type: "post",
			slug: "p2",
			data: { title: "P2" },
			status: "published",
		});

		await taxRepo.attachToEntry("post", live.id, term.id);
		await taxRepo.attachToEntry("post", trashed.id, term.id);

		await contentRepo.delete("post", trashed.id);

		const terms = await getTaxonomyTerms("category");
		expect(terms.find((t) => t.slug === "news")?.count).toBe(1);
	});

	it("returns zero count when only drafts are attached", async () => {
		const term = await taxRepo.create({ name: "category", slug: "empty", label: "Empty" });
		const draft = await contentRepo.create({
			type: "post",
			slug: "d",
			data: { title: "D" },
			status: "draft",
		});
		await taxRepo.attachToEntry("post", draft.id, term.id);

		const terms = await getTaxonomyTerms("category");
		expect(terms.find((t) => t.slug === "empty")?.count).toBe(0);
	});
});
