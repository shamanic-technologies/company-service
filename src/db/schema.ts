import { pgTable, serial, varchar, timestamp, index, unique, uuid, text, uniqueIndex, foreignKey, check, date, jsonb, integer, boolean, bigint, numeric, json, primaryKey, pgView, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const belongingConfidenceLevelEnum = pgEnum("belonging_confidence_level_enum", ['found_online', 'guessed', 'user_inputed'])
export const organizationIndividualStatus = pgEnum("organization_individual_status", ['active', 'ended', 'hidden'])
export const organizationIndividualThesisStatus = pgEnum("organization_individual_thesis_status", ['pending', 'validated', 'denied', 'generating'])
export const organizationRelationStatus = pgEnum("organization_relation_status", ['active', 'ended', 'hidden', 'not_related'])
export const organizationRelationType = pgEnum("organization_relation_type", ['subsidiary', 'holding', 'product', 'main_company', 'client', 'supplier', 'shareholder', 'other'])
export const webPageCategoryEnum = pgEnum("web_page_category_enum", ['company_info', 'offerings', 'credibility', 'content', 'legal', 'other'])


export const pgmigrations = pgTable("pgmigrations", {
	id: serial().primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	runOn: timestamp("run_on", { mode: 'string' }).notNull(),
});

/**
 * Silver brand table. Global identity — one row per normalized domain.
 * No `org_id` — membership lives in `org_brands` (gold). No business
 * columns — they are fetched on demand via brand_extracted_fields.
 */
export const brands = pgTable("brands", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	// `domain` and `url` are NULLABLE: a brand created WITHOUT a website (the
	// no-website onboarding flow) has neither. Such a brand is identified by its
	// user-provided `name` instead, and its extraction source is the pasted
	// business context (brand_business_context) rather than a scraped site. The
	// unique index on `domain` still dedups website brands (Postgres treats NULLs
	// as distinct, so multiple no-website brands each get their own row — correct:
	// two nameless-domain businesses are genuinely distinct identities).
	domain: text(),
	url: text(),
	name: text(),
	logoUrl: text("logo_url"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("brands_domain_key").on(table.domain),
]);

/**
 * Legacy `brands_old` table, preserved as a safety net during the
 * silver/gold/bronze migration. Holds the previous schema with `org_id` and
 * all business columns. New code MUST NOT read from this table — the only
 * supported access is read-only diagnostic queries until it is dropped in a
 * follow-up PR.
 */
export const brandsOld = pgTable("brands_old", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text(),
	url: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	externalOrganizationId: text("external_organization_id"),
	organizationLinkedinUrl: text("organization_linkedin_url"),
	domain: text().notNull(),
	status: text(),
	generatingStartedAt: timestamp("generating_started_at", { withTimezone: true, mode: 'string' }),
	location: text(),
	bio: text(),
	elevatorPitch: text("elevator_pitch"),
	mission: text(),
	story: text(),
	offerings: text(),
	problemSolution: text("problem_solution"),
	goals: text(),
	categories: text(),
	foundedDate: date("founded_date"),
	contactName: text("contact_name"),
	contactEmail: text("contact_email"),
	contactPhone: text("contact_phone"),
	socialMedia: jsonb("social_media"),
	logoUrl: text("logo_url"),
	orgId: uuid("org_id").notNull(),
});

/**
 * Gold membership table: which org claims which brand. N:N — multiple orgs
 * may track the same brand and each org tracks many brands.
 *
 * It also carries the per-org configuration of that relationship, starting with
 * `current_goal`. A goal is NOT a property of the brand: `brands` is the global
 * silver identity (domain, name, logo) that several orgs legitimately share, so
 * a goal stored there let any org overwrite what another org optimizes for on
 * the same domain. It belongs to the (org, brand) pair, which is exactly this
 * row.
 */
export const orgBrands = pgTable("org_brands", {
	orgId: uuid("org_id").notNull(),
	brandId: uuid("brand_id").notNull(),
	// What THIS org optimizes for on THIS brand. Moved off `brands` — see above.
	currentGoal: text("current_goal").default('websitePurchase').notNull(),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.brandId] }),
	// The fleet's canonical goal vocabulary — the only tokens this column may
	// hold, and the only ones brand-service emits. See src/lib/goal-vocabulary.ts.
	check("org_brands_current_goal_check", sql`${table.currentGoal} IN ('signup', 'meetingBooked', 'websitePurchase', 'combinedSales', 'websiteVisit', 'positiveReply', 'formSubmission', 'whatsappConversation')`),
	index("org_brands_brand_id_idx").on(table.brandId),
	index("org_brands_org_id_idx").on(table.orgId),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "org_brands_brand_id_fkey",
		}).onDelete("cascade"),
]);

/**
 * Brand-level sales conversion economics. One row per brand (PK = brand_id),
 * reused across every sales-cold-email campaign for that brand. The funnel
 * semantics are sales-cold-email's; the metrics are brand-scoped persisted
 * config (analogous to `intake_forms`). Unset simply means no row.
 *
 * This row is the brand-level bag of economic facts the revenue-overview
 * pipeline reads. New facts are added as typed nullable columns (one per fact).
 */
export const brandSalesEconomics = pgTable("brand_sales_economics", {
	orgId: uuid("org_id").notNull(),
	brandId: uuid("brand_id").notNull(),
	lifetimeRevenueUsd: integer("lifetime_revenue_usd").notNull(),
	replyToMeetingPct: numeric("reply_to_meeting_pct", { precision: 7, scale: 4, mode: "number" }).notNull(),
	visitToMeetingPct: numeric("visit_to_meeting_pct", { precision: 7, scale: 4, mode: "number" }).notNull(),
	meetingToClosePct: numeric("meeting_to_close_pct", { precision: 7, scale: 4, mode: "number" }).notNull(),
	// Self-serve funnel split into two sub-rates. NOT NULL with DB defaults
	// (25 / 20) — a row inserted without them reads those, mirroring the
	// funnelStages/optimizationGoal default convention below.
	visitToSignupPct: numeric("visit_to_signup_pct", { precision: 7, scale: 4, mode: "number" }).default(25).notNull(),
	signupToPaidClientPct: numeric("signup_to_paid_client_pct", { precision: 7, scale: 4, mode: "number" }).default(20).notNull(),
	// Single-step conversion rates for the beta goals website_visits / positive_replies:
	// each is a straight visit→paid-client / reply→paid-client rate (no intermediate
	// step). NOT NULL with DB defaults (5 / 25) — a never-set brand reads those.
	visitToPaidClientPct: numeric("visit_to_paid_client_pct", { precision: 7, scale: 4, mode: "number" }).default(5).notNull(),
	replyToPaidClientPct: numeric("reply_to_paid_client_pct", { precision: 7, scale: 4, mode: "number" }).default(25).notNull(),
	// Two-step conversion rates for the form_submissions goal (visit→form
	// submission→paid). NOT NULL with DB defaults (25 / 20) — mirrors the
	// visitToSignupPct/signupToPaidClientPct two-step pair (form_submissions
	// collapses to the `signup` runtime goal). Consumers (features-service) fail
	// loud on a null rate for a form_submissions-goal brand, so these are served
	// as real numbers everywhere (saved read, effective, cross-brand-average),
	// identically to the single-step rates.
	visitToFormSubmissionPct: numeric("visit_to_form_submission_pct", { precision: 7, scale: 4, mode: "number" }).default(25).notNull(),
	formSubmissionToPaidClientPct: numeric("form_submission_to_paid_client_pct", { precision: 7, scale: 4, mode: "number" }).default(20).notNull(),
	// DERIVED on every write = visitToSignupPct * signupToPaidClientPct / 100.
	// Kept as a stored column so the revenue/projection engine (features-service)
	// keeps reading it unchanged; never written directly by a caller.
	visitToClosePct: numeric("visit_to_close_pct", { precision: 7, scale: 4, mode: "number" }).notNull(),
	// Brand-level B2C vs B2B classification. Nullable: null = never set.
	// Additive field — older callers omit it; see salesEconomicsService upsert.
	businessModel: text("business_model"),
	// Sales-funnel stages the brand has (subset of website_purchase | sales_meeting).
	// NOT NULL default [] — a never-set brand reads []; see upsert.
	funnelStages: jsonb("funnel_stages").$type<string[]>().default([]).notNull(),
	// A MIRROR of org_brands.current_goal, in the same canonical vocabulary.
	// Nothing reads it: it existed to record the raw wire spelling back when two
	// wire values (form_submissions, website_purchase) shared one runtime goal,
	// and both are first-class goals now. NOT NULL default 'websitePurchase'.
	optimizationGoal: text("optimization_goal").default('websitePurchase').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.brandId] }),
	foreignKey({
		columns: [table.brandId],
		foreignColumns: [brands.id],
		name: "brand_sales_economics_brand_id_fkey",
	}).onDelete("cascade"),
]);

/**
 * Brand-level click destination URL. One row per brand (PK = brand_id), reused
 * across every outreach campaign for that brand — analogous to
 * `brand_sales_economics` / `brands.current_goal` per-brand config, NOT brand
 * global identity. The page outreach clicks should land on; default (no row) is
 * the brand's own domain, which the user can override with another page of their
 * site. Stored as a dedicated config table (not on the `brands` identity row) so
 * it mirrors the sales-economics scoping. `click_destination_url` is NOT NULL —
 * the row's presence IS the "set" signal; an unset brand simply has no row, and
 * the brand read (getBrandDetail) then defaults `clickDestinationUrl` to the
 * brand's own landing `url` so the response value is never null.
 */
export const brandClickDestinations = pgTable("brand_click_destinations", {
	orgId: uuid("org_id").notNull(),
	brandId: uuid("brand_id").notNull(),
	clickDestinationUrl: text("click_destination_url").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.brandId] }),
	foreignKey({
		columns: [table.brandId],
		foreignColumns: [brands.id],
		name: "brand_click_destinations_brand_id_fkey",
	}).onDelete("cascade"),
]);

/**
 * Brand-level WhatsApp link. One row per brand (PK = brand_id) — "unique per
 * brand" — reused across every outreach campaign for that brand, analogous to
 * `brand_click_destinations` / `brand_sales_economics` per-brand config, NOT
 * brand global identity. Stores the WhatsApp click destination the outreach /
 * sending pipeline points recipients at for the "maximize WhatsApp
 * conversations" goal. `whatsapp_link` is NOT NULL — the row's presence IS the
 * "set" signal; an unset brand simply has no row, and the brand read
 * (getBrandDetail) then returns `whatsAppLink: null`. A bare phone number is
 * normalized to a `https://wa.me/<digits>` link before storage; an existing
 * wa.me / api.whatsapp.com URL is stored as-is.
 */
export const brandWhatsappLinks = pgTable("brand_whatsapp_links", {
	orgId: uuid("org_id").notNull(),
	brandId: uuid("brand_id").notNull(),
	whatsappLink: text("whatsapp_link").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.brandId] }),
	foreignKey({
		columns: [table.brandId],
		foreignColumns: [brands.id],
		name: "brand_whatsapp_links_brand_id_fkey",
	}).onDelete("cascade"),
]);

/**
 * Brand SHARE token — the per-brand read-only share credential. A member of an
 * org that claims the brand mints one on demand so somebody OUTSIDE the org (an
 * investor, a client, a colleague) can open a read-only public brand page with
 * no distribute account.
 *
 * One row per brand (PK = brand_id), so a brand has AT MOST ONE live credential:
 * rotating overwrites `token` in place, which is exactly what makes the previous
 * link stop resolving. Revoking DELETES the row — absence is the "not shareable"
 * signal, and a brand is not shareable until someone asks for it (no row is
 * created at brand create).
 *
 * `token` is a 32-byte CSPRNG value (see `brandShareTokenService`), NOT derived
 * from the brand id, the org id, or anything else the customer already exposes
 * in their address bar. UNIQUE so a resolve is an exact single-row lookup and
 * two brands can never collide onto one credential.
 *
 * `org_id` is WHICH ORG SHARED THE BRAND — recorded when the credential is
 * minted (or re-minted by a rotate), never derived on read. The minting route is
 * org-scoped and brand-ownership-checked, so the writer already holds this and
 * the only place it can be stored truthfully is here: `org_brands` cannot answer
 * it, because a brand may be claimed by several orgs (21 in production) or by
 * none (18). It is stored, not encoded in the token — the credential stays an
 * opaque CSPRNG value that reveals nothing on its own.
 *
 * Deliberately NOT a conversion-tracking token: that one (lead-service) is a
 * WRITE credential for conversion ingest, and a share link holder must never be
 * able to forge conversions.
 *
 * NOT carried by `rewriteBrandReferences` (the merge primitive) — like
 * `brand_transfers` / `brand_relations`. Moving a credential minted for the
 * abandoned holder onto the target brand would silently widen what every
 * existing link holder can see; the credential stays with the brand it was
 * minted for.
 */
export const brandShareTokens = pgTable("brand_share_tokens", {
	orgId: uuid("org_id").notNull(),
	brandId: uuid("brand_id").notNull(),
	token: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.brandId] }),
	uniqueIndex("brand_share_tokens_token_key").on(table.token),
	foreignKey({
		columns: [table.brandId],
		foreignColumns: [brands.id],
		name: "brand_share_tokens_brand_id_fkey",
	}).onDelete("cascade"),
]);

/**
 * An OFFER — one distinct thing a brand sells.
 *
 * The level between a brand and a campaign. A brand is an IDENTITY (a name, a
 * domain, a logo); an offer is a PROPOSITION: the value it promises (the 7
 * Hormozi user-fields) and the sales funnels it is sold through, with their
 * conversion rates, their lifetime revenue and their destinations. All of that
 * used to hang off the brand, which forced a brand selling a $200 self-serve
 * plan and a $20k contract to describe both as one thing — one set of rates, one
 * lifetime revenue, one value proposition. `brand_user_fields` and
 * `brand_sales_funnels` now hang off a row here instead.
 *
 * ORG-SCOPED like every other config table: `brands` is the global silver
 * identity several orgs legitimately share, so what an org sells under a brand
 * is the data of an (org, brand) pair and never a property of the brand.
 *
 * THERE IS NO PRIMARY OFFER. Several run at once and none outranks another —
 * the same rule the sales-funnel model settled on, for the same reason: ranking
 * them is a question for whoever is spending money, not for the record of what
 * exists.
 *
 * The brand's IDENTITY stays on the brand, deliberately: the name, the domain,
 * the logo and the conversion-tracking credential describe the company, not one
 * of the things it sells, and two offers of one brand share every one of them.
 */
export const brandOffers = pgTable("brand_offers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	brandId: uuid("brand_id").notNull(),
	// AT MOST 2 WORDS, AT MOST 20 CHARACTERS — an owner-fixed limit, enforced here
	// by a CHECK and at the write path by `offerNameProblem` so the caller gets a
	// sentence rather than a constraint-violation string. It is the only word
	// anyone reads for this offer: a longer one is a description and truncates
	// differently on every surface that renders it. UNIQUE within the (org, brand)
	// pair — two offers a reader cannot tell apart are two offers nobody can pick
	// between.
	name: text().notNull(),
	// PROVENANCE, for the one-time migration that gave every brand already
	// selling something the single offer carrying all of it. Set to the moment
	// that offer was created; NULL for every offer a user or a caller created
	// directly. It is what makes the migration reversible by an exact predicate
	// rather than a timestamp window, what makes its result countable from an
	// independent query instead of the script's own log, and what makes a re-run
	// a no-op. Read by nothing.
	migratedAt: timestamp("migrated_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("brand_offers_org_id_brand_id_name_key").on(table.orgId, table.brandId, table.name),
	foreignKey({
		columns: [table.brandId],
		foreignColumns: [brands.id],
		name: "brand_offers_brand_id_fkey",
	}).onDelete("cascade"),
	// The two limits, in the database as well as in the write path. Belt and
	// braces on purpose: a name is what four other services will key their
	// display on, and a script that writes around the service must not be able to
	// create one no surface can render.
	check(
		"brand_offers_name_length_check",
		sql`char_length(btrim(${table.name})) BETWEEN 1 AND 20`
	),
	// `\\s` and not `\s`: a template literal eats the backslash, so `'\s+'` would
	// reach Postgres as `'s+'` and split every name on the LETTER s — "User
	// Fields" becomes three words and a perfectly legal name is refused. Caught
	// by the integration suite as a 500 on the first user-fields write.
	check(
		"brand_offers_name_words_check",
		sql`array_length(regexp_split_to_array(btrim(${table.name}), '\\s+'), 1) <= 2`
	),
]);

/**
 * The sales funnels an org sells a brand through, and what each one is worth.
 *
 * One row per (org, brand, funnel). `active` says whether the org currently
 * sells through that funnel; the ROW itself is the MEMORY and is not deleted
 * when a funnel is switched off, so the rates, lifetime revenue and
 * destinations a user entered are still there when they switch it back on.
 *
 * ORG-SCOPED for the same reason as every other config table here: `brands` is
 * the global silver identity that several orgs legitimately share, so what an
 * org sells through — and what it earns — is the data of an (org, brand) pair,
 * never a property of the brand.
 *
 * Nothing is inferred from the values: every value column is NULLABLE with NO
 * server default, so `null` means "the org never gave us this number" and never
 * "0". `brand_sales_economics` cannot express that (every rate there is NOT
 * NULL with a default, so absence signals nothing) — which is exactly why the
 * set of funnels can only be declared, never derived from it.
 *
 * INVARIANT: an org that has answered always has at least ONE active funnel.
 * "All inactive" is only the initial state, and the initial state is NO ROWS at
 * all — so zero rows means "never answered" and is the only way to say it.
 * Switching off the last active funnel is refused.
 *
 * Which rate columns a funnel may fill is NOT free-form: `salesFunnelCatalogue`
 * owns the funnel of each funnel, and a write naming a rate outside that funnel is
 * rejected 400 rather than silently dropped.
 *
 * `meeting_booked_to_attended_pct` and `booking_url` exist ONLY here — they are
 * the two values the funnel model needs that had no home anywhere in the fleet.
 */
export const brandSalesFunnels = pgTable("brand_sales_funnels", {
	// Surrogate key. The natural key USED to be (org_id, brand_id, funnel_key) and
	// was the primary key; it stopped being unique the day a brand could hold
	// several OFFERS, because two offers of one brand legitimately sell through
	// the same funnel at different rates and a different lifetime revenue. The
	// natural key is now (offer_id, funnel_key), enforced by a unique index.
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	brandId: uuid("brand_id").notNull(),
	// The OFFER this funnel prices. Conversion rates and a lifetime revenue
	// describe ONE thing a brand sells, so they hang off the offer rather than
	// the brand: a brand selling a $200 self-serve plan and a $20k contract
	// converts and is worth completely different numbers on the same funnel.
	//
	// NULLABLE at the database, NOT NULL at the write path, and the gap between
	// the two is the one-time migration: the offer a pre-offer brand gets is
	// NAMED from what that brand actually sells, which is an LLM call and
	// therefore a script rather than a line of DDL. Every row a caller writes
	// from now on carries one. A row still holding NULL is a row the migration
	// has not reached, and it is exactly what makes the migration idempotent —
	// a second run finds no candidates.
	offerId: uuid("offer_id"),
	funnelKey: text("funnel_key").notNull(),
	// Whether the brand currently sells through this funnel. The ROW is the
	// memory and is never deleted on the normal path: switching a funnel off
	// keeps its rates, its lifetime revenue and its destinations exactly where
	// they were, so switching it back on returns what the user already entered
	// instead of an empty form.
	active: boolean("active").default(true).notNull(),
	// What a client won through THIS funnel is worth. Null = never declared.
	lifetimeRevenueUsd: integer("lifetime_revenue_usd"),
	// One column per leg the catalogue can reference. A funnel fills only the
	// legs of its own funnel; the rest stay null for that row.
	replyToMeetingPct: numeric("reply_to_meeting_pct", { precision: 7, scale: 4, mode: "number" }),
	visitToMeetingPct: numeric("visit_to_meeting_pct", { precision: 7, scale: 4, mode: "number" }),
	// The meeting SHOW-UP rate — booked → actually attended. It sits in the
	// middle of both meeting funnels and is stored nowhere else in the fleet.
	meetingBookedToAttendedPct: numeric("meeting_booked_to_attended_pct", { precision: 7, scale: 4, mode: "number" }),
	meetingToClosePct: numeric("meeting_to_close_pct", { precision: 7, scale: 4, mode: "number" }),
	visitToSignupPct: numeric("visit_to_signup_pct", { precision: 7, scale: 4, mode: "number" }),
	signupToPaidClientPct: numeric("signup_to_paid_client_pct", { precision: 7, scale: 4, mode: "number" }),
	visitToFormSubmissionPct: numeric("visit_to_form_submission_pct", { precision: 7, scale: 4, mode: "number" }),
	formSubmissionToPaidClientPct: numeric("form_submission_to_paid_client_pct", { precision: 7, scale: 4, mode: "number" }),
	// The legs of the funnels that begin somewhere other than a conversation
	// leading to a meeting, or the brand's own website. None of these has a
	// counterpart on the brand-wide `brand_sales_economics` record — that record
	// predates them — so they are stated on the funnel or not at all.
	replyToPaidClientPct: numeric("reply_to_paid_client_pct", { precision: 7, scale: 4, mode: "number" }),
	adClickToMeetingPct: numeric("ad_click_to_meeting_pct", { precision: 7, scale: 4, mode: "number" }),
	adClickToLeadFormPct: numeric("ad_click_to_lead_form_pct", { precision: 7, scale: 4, mode: "number" }),
	leadFormToPaidClientPct: numeric("lead_form_to_paid_client_pct", { precision: 7, scale: 4, mode: "number" }),
	// The page on the brand's own site this funnel's outreach click lands on.
	// Null = never declared (the brand's own landing page is the fallback the
	// CONSUMER applies, never a value written here).
	destinationUrl: text("destination_url"),
	// The scheduling page, for a funnel whose funnel contains a meeting. Always
	// optional — a brand that books over email still runs the funnel.
	bookingUrl: text("booking_url"),
	// PROVENANCE, for the one-time backfill that gave every brand carrying a
	// retired goal the declaration that goal meant. Holds the goal token the row
	// was derived from; NULL for every row a user or a caller declared directly.
	// It is what makes the backfill reversible by an exact predicate rather than
	// by a timestamp window, and what lets its result be counted from an
	// independent query instead of the script's own log. Read by nothing.
	backfilledFromGoal: text("backfilled_from_goal"),
	// PROVENANCE, for the one-time economics backfill that moved the numbers a
	// brand stated on `brand_sales_economics` — before the funnel model existed —
	// onto the funnel(s) that replaced them. Set to the moment the copy was made;
	// NULL for every value a user or a caller wrote directly. It is what makes
	// that backfill identifiable (so it can be undone by an exact predicate) and
	// what makes a re-run a no-op. Read by nothing.
	economicsBackfilledAt: timestamp("economics_backfilled_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	// The natural key, now that a brand holds offers: one declaration of a funnel
	// PER OFFER. `offer_id` is nullable, and Postgres treats NULLs as distinct, so
	// this index constrains nothing while rows wait for the migration — which is
	// what the partial index below is for.
	uniqueIndex("brand_sales_funnels_offer_id_funnel_key_key").on(table.offerId, table.funnelKey),
	// The PREVIOUS natural key, kept for exactly the rows the migration has not
	// reached yet. Without it, dropping the old primary key would leave
	// un-migrated rows with no uniqueness at all and a legacy write could create
	// a second row for the same (org, brand, funnel) — silently splitting a
	// brand's economics across two rows nothing would ever reconcile.
	uniqueIndex("brand_sales_funnels_unmigrated_key")
		.on(table.orgId, table.brandId, table.funnelKey)
		.where(sql`offer_id IS NULL`),
	// THE funnel vocabulary — the only tokens brand-service stores or emits for
	// what a brand sells through. The pre-retirement spellings (reply_meeting,
	// visit_meeting, visit_signup, visit_form) are accepted on the WIRE forever
	// and resolved before they reach this column; they are never stored again.
	check(
		"brand_sales_funnels_funnel_key_check",
		sql`${table.funnelKey} IN ('sales_meetings_from_conversation', 'sales_meetings_from_website', 'website_purchases', 'form_magnet', 'sales_from_conversation', 'sales_meetings_from_ads', 'lead_forms_from_ads')`
	),
	foreignKey({
		columns: [table.brandId],
		foreignColumns: [brands.id],
		name: "brand_sales_funnels_brand_id_fkey",
	}).onDelete("cascade"),
	// Deleting an offer takes its economics with it: a rate that prices nothing
	// is not a number anyone can read.
	foreignKey({
		columns: [table.offerId],
		foreignColumns: [brandOffers.id],
		name: "brand_sales_funnels_offer_id_fkey",
	}).onDelete("cascade"),
]);

/**
 * Brand business context — the free-form text a user pastes when their brand
 * has NO website. It is the ALTERNATIVE field-extraction SOURCE to a scraped
 * site: when a brand has no `url`, `fieldExtractionService.extractFields` reads
 * this text and runs the same LLM extraction against it instead of scraping.
 * One row per brand (PK = brand_id), durable (no TTL — this is user-authored
 * input, not the ephemeral extract cache). `content` can be large (~1MB / ~300k
 * chars — think several pasted PDFs); Postgres `text` has no practical limit and
 * the write route raises the body-size cap. Per-brand config, mirrors
 * click-destination / whatsapp-link scoping — never on the brand identity row.
 */
export const brandBusinessContext = pgTable("brand_business_context", {
	orgId: uuid("org_id").notNull(),
	brandId: uuid("brand_id").notNull(),
	content: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.orgId, table.brandId] }),
	foreignKey({
		columns: [table.brandId],
		foreignColumns: [brands.id],
		name: "brand_business_context_brand_id_fkey",
	}).onDelete("cascade"),
]);

/**
 * Brand USER fields — the user-facing "confirmed" layer of the 2-layer brand
 * fields model. One row per (brand_id, field_key), restricted to the 7
 * user-validated field keys (services, dreamOutcome, perceivedLikelihood,
 * socialProof, riskReversal, urgency, scarcity). DURABLE — no TTL, never
 * garbage-collected (the ephemeral auto-extract cache lives on
 * brand_extracted_fields). A row's presence means the user confirmed that
 * field; consumers tag it provenance `confirmed`. `value` is a free-form jsonb
 * (string | string[] | object).
 */
export const brandUserFields = pgTable("brand_user_fields", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	orgId: uuid("org_id").notNull(),
	brandId: uuid("brand_id").notNull(),
	// The OFFER whose value proposition this field states. The 7 Hormozi levers
	// describe ONE thing a brand sells — a dream outcome, a risk reversal and a
	// scarcity are claims about an offer, not about a company — so they hang off
	// the offer rather than the brand.
	//
	// NULLABLE at the database and NOT NULL at the write path, for the same
	// reason as `brand_sales_funnels.offer_id`: the offer a pre-offer brand gets
	// is NAMED from what that brand sells, which is a script and not DDL. A row
	// still holding NULL is one the migration has not reached.
	offerId: uuid("offer_id"),
	fieldKey: text("field_key").notNull(),
	value: jsonb(),
	confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	// The natural key, now that a brand holds offers: one confirmed value per
	// (offer, field). Constrains nothing while `offer_id` is NULL — Postgres
	// treats NULLs as distinct — which is what the partial index below covers.
	uniqueIndex("brand_user_fields_offer_id_field_key_key").on(table.offerId, table.fieldKey),
	// The PREVIOUS natural key, for exactly the rows the migration has not
	// reached. Without it an un-migrated brand could grow two confirmed values
	// for one field and no read could say which the user meant.
	uniqueIndex("brand_user_fields_unmigrated_key")
		.on(table.orgId, table.brandId, table.fieldKey)
		.where(sql`offer_id IS NULL`),
	foreignKey({
		columns: [table.brandId],
		foreignColumns: [brands.id],
		name: "brand_user_fields_brand_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.offerId],
		foreignColumns: [brandOffers.id],
		name: "brand_user_fields_offer_id_fkey",
	}).onDelete("cascade"),
	check("brand_user_fields_field_key_check", sql`${table.fieldKey} IN ('services', 'dreamOutcome', 'perceivedLikelihood', 'socialProof', 'riskReversal', 'urgency', 'scarcity')`),
]);

/**
 * Bronze append-only raw scrape payload table. Future writes go here;
 * existing scrape caches live on `_old` tables until consumers migrate.
 */
export const scrapeRaw = pgTable("scrape_raw", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	url: text().notNull(),
	normalizedUrl: text("normalized_url").notNull(),
	source: text().notNull(),
	payload: jsonb().notNull(),
	fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("scrape_raw_normalized_url_fetched_at_key").on(table.normalizedUrl, table.fetchedAt),
	index("scrape_raw_normalized_url_idx").on(table.normalizedUrl),
	index("scrape_raw_fetched_at_idx").on(table.fetchedAt.desc()),
]);

export const individualsPdlEnrichment = pgTable("individuals_pdl_enrichment", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	individualId: uuid("individual_id").notNull(),
	organizationUrl: text("organization_url"),
	rawData: jsonb("raw_data").notNull(),
	pdlId: text("pdl_id"),
	fullName: text("full_name"),
	firstName: text("first_name"),
	middleName: text("middle_name"),
	lastName: text("last_name"),
	sex: text(),
	birthYear: integer("birth_year"),
	linkedinUrl: text("linkedin_url"),
	linkedinUsername: text("linkedin_username"),
	linkedinId: text("linkedin_id"),
	facebookUrl: text("facebook_url"),
	twitterUrl: text("twitter_url"),
	githubUrl: text("github_url"),
	jobTitle: text("job_title"),
	jobTitleRole: text("job_title_role"),
	jobTitleSubRole: text("job_title_sub_role"),
	jobTitleClass: text("job_title_class"),
	jobTitleLevels: text("job_title_levels").array(),
	jobCompanyName: text("job_company_name"),
	jobCompanyWebsite: text("job_company_website"),
	jobCompanySize: text("job_company_size"),
	jobCompanyIndustry: text("job_company_industry"),
	jobCompanyLinkedinUrl: text("job_company_linkedin_url"),
	jobStartDate: text("job_start_date"),
	jobLastVerified: date("job_last_verified"),
	locationName: text("location_name"),
	locationLocality: text("location_locality"),
	locationRegion: text("location_region"),
	locationCountry: text("location_country"),
	locationContinent: text("location_continent"),
	locationGeo: text("location_geo"),
	workEmailAvailable: boolean("work_email_available"),
	personalEmailsAvailable: boolean("personal_emails_available"),
	mobilePhoneAvailable: boolean("mobile_phone_available"),
	skills: text().array(),
	experience: jsonb(),
	education: jsonb(),
	datasetVersion: text("dataset_version"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	interests: text().array(),
	likelihood: integer(),
	countries: text().array(),
	jobCompanyFounded: integer("job_company_founded"),
	jobCompanyLocationCountry: text("job_company_location_country"),
	jobLastChanged: date("job_last_changed"),
	recommendedPersonalEmail: text("recommended_personal_email"),
}, (table) => [
	index().using("gin", table.education.asc().nullsLast().op("jsonb_ops")),
	index().using("gin", table.experience.asc().nullsLast().op("jsonb_ops")),
	index().using("btree", table.individualId.asc().nullsLast().op("uuid_ops")),
	index().using("gin", table.interests.asc().nullsLast().op("array_ops")),
	index().using("btree", table.jobCompanyLocationCountry.asc().nullsLast().op("text_ops")),
	index().using("btree", table.jobCompanyName.asc().nullsLast().op("text_ops")),
	index().using("btree", table.likelihood.asc().nullsLast().op("int4_ops")),
	index().using("btree", table.linkedinUrl.asc().nullsLast().op("text_ops")),
	index().using("btree", table.organizationUrl.asc().nullsLast().op("text_ops")),
	index().using("btree", table.pdlId.asc().nullsLast().op("text_ops")),
	index().using("gin", table.rawData.asc().nullsLast().op("jsonb_ops")),
	foreignKey({
			columns: [table.individualId],
			foreignColumns: [individuals.id],
			name: "individuals_pdl_enrichment_individual_id_fkey"
		}).onDelete("cascade"),
	unique("individuals_pdl_enrichment_individual_id_unique").on(table.individualId),
	unique("individuals_pdl_enrichment_pdl_id_key").on(table.pdlId),
]);

export const mediaAssets = pgTable("media_assets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	assetType: text("asset_type").notNull(),
	assetUrl: text("asset_url").notNull(),
	supabaseStorageId: uuid("supabase_storage_id"),
	optimizedUrl: text("optimized_url"),
	caption: text(),
	altText: text("alt_text"),
	isShareable: boolean("is_shareable").default(true).notNull(),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	brandId: uuid("brand_id"),
}, (table) => [
	index().using("btree", table.assetType.asc().nullsLast().op("text_ops")),
	index("media_assets_organization_id_index").using("btree", table.brandId.asc().nullsLast().op("uuid_ops")),
	// The two operator classes were introspected onto the WRONG columns (uuid
	// tagged `bool_ops`, boolean tagged `uuid_ops`). It never surfaced while
	// `drizzle-kit push` only ever ran against a database that already had this
	// index; building the schema from empty, Postgres rejects it outright
	// (`operator class "bool_ops" does not accept data type uuid`) and push
	// abandons the rest of the run while still exiting 0.
	index("media_assets_organization_id_is_shareable_index").using("btree", table.brandId.asc().nullsLast().op("uuid_ops"), table.isShareable.asc().nullsLast().op("bool_ops")),
	index().using("btree", table.supabaseStorageId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.supabaseStorageId],
			foreignColumns: [supabaseStorage.id],
			name: "media_assets_supabase_storage_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "media_assets_organization_id_fkey"
		}).onDelete("cascade"),
	unique("media_assets_asset_url_unique").on(table.assetUrl),
	check("media_assets_asset_type_check", sql`asset_type = ANY (ARRAY['uploaded_file'::text, 'youtube'::text, 'spotify'::text, 'vimeo'::text, 'soundcloud'::text, 'other'::text])`),
]);

export const supabaseStorage = pgTable("supabase_storage", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	supabaseUrl: text("supabase_url").notNull(),
	storageBucket: text("storage_bucket").notNull(),
	storagePath: text("storage_path").notNull(),
	fileName: text("file_name").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fileSize: bigint("file_size", { mode: "number" }),
	mimeType: text("mime_type"),
	fileExtension: text("file_extension"),
	width: integer(),
	height: integer(),
	duration: numeric(),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	md5Hash: text("md5_hash"),
}, (table) => [
	index().using("btree", table.md5Hash.asc().nullsLast().op("text_ops")),
	index().using("btree", table.storageBucket.asc().nullsLast().op("text_ops"), table.storagePath.asc().nullsLast().op("text_ops")),
	unique("supabase_storage_supabase_url_key").on(table.supabaseUrl),
]);

export const individuals = pgTable("individuals", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	firstName: text("first_name").notNull(),
	lastName: text("last_name"),
	linkedinUrl: text("linkedin_url"),
	personalWebsiteUrl: text("personal_website_url"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index().using("btree", table.linkedinUrl.asc().nullsLast().op("text_ops")),
	unique("individuals_linkedin_url_key").on(table.linkedinUrl),
]);

export const brandLinkedinPosts = pgTable("brand_linkedin_posts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	brandId: uuid("brand_id").notNull(),
	rawData: jsonb("raw_data").notNull(),
	postType: text("post_type").notNull(),
	linkedinPostId: text("linkedin_post_id").notNull(),
	linkedinUrl: text("linkedin_url").notNull(),
	content: text(),
	contentAttributes: jsonb("content_attributes"),
	author: jsonb(),
	authorName: text("author_name"),
	authorLinkedinUrl: text("author_linkedin_url"),
	authorUniversalName: text("author_universal_name"),
	postedAt: timestamp("posted_at", { withTimezone: true, mode: 'string' }),
	postedAtData: jsonb("posted_at_data"),
	postImages: jsonb("post_images"),
	hasImages: boolean("has_images").default(false),
	repostId: text("repost_id"),
	repostData: jsonb("repost_data"),
	isRepost: boolean("is_repost").default(false),
	socialContent: jsonb("social_content"),
	engagement: jsonb(),
	likesCount: integer("likes_count").default(0),
	commentsCount: integer("comments_count").default(0),
	sharesCount: integer("shares_count").default(0),
	impressionsCount: integer("impressions_count").default(0),
	reactions: jsonb(),
	comments: jsonb(),
	header: jsonb(),
	article: jsonb(),
	articleLink: text("article_link"),
	articleTitle: text("article_title"),
	hasArticle: boolean("has_article").default(false),
	input: jsonb(),
	query: jsonb(),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	authorAvatarUrl: text("author_avatar_url"),
	authorInfo: jsonb("author_info"),
	articleImageUrl: text("article_image_url"),
	articleDescription: text("article_description"),
}, (table) => [
	index("organizations_linkedin_posts_author_linkedin_url_index").using("btree", table.authorLinkedinUrl.asc().nullsLast().op("text_ops")),
	index("organizations_linkedin_posts_author_universal_name_index").using("btree", table.authorUniversalName.asc().nullsLast().op("text_ops")),
	index("organizations_linkedin_posts_content_attributes_index").using("gin", table.contentAttributes.asc().nullsLast().op("jsonb_ops")),
	index("organizations_linkedin_posts_content_search_idx").using("gin", sql`to_tsvector('english'::regconfig, COALESCE(content, ''::text))`),
	index("organizations_linkedin_posts_engagement_index").using("gin", table.engagement.asc().nullsLast().op("jsonb_ops")),
	index("organizations_linkedin_posts_has_article_index").using("btree", table.hasArticle.asc().nullsLast().op("bool_ops")),
	index("organizations_linkedin_posts_is_repost_index").using("btree", table.isRepost.asc().nullsLast().op("bool_ops")),
	index("organizations_linkedin_posts_linkedin_post_id_index").using("btree", table.linkedinPostId.asc().nullsLast().op("text_ops")),
	index("organizations_linkedin_posts_organization_id_index").using("btree", table.brandId.asc().nullsLast().op("uuid_ops")),
	index("organizations_linkedin_posts_post_type_index").using("btree", table.postType.asc().nullsLast().op("text_ops")),
	index("organizations_linkedin_posts_posted_at_index").using("btree", table.postedAt.asc().nullsLast().op("timestamptz_ops")),
	index("organizations_linkedin_posts_raw_data_index").using("gin", table.rawData.asc().nullsLast().op("jsonb_ops")),
	index("organizations_linkedin_posts_reactions_index").using("gin", table.reactions.asc().nullsLast().op("jsonb_ops")),
	index("organizations_linkedin_posts_repost_id_index").using("btree", table.repostId.asc().nullsLast().op("text_ops")),
	index("organizations_linkedin_posts_scraped_at_index").using("btree", table.scrapedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "organizations_linkedin_posts_organization_id_fkey"
		}).onDelete("cascade"),
	unique("organizations_linkedin_posts_linkedin_post_id_key").on(table.linkedinPostId),
]);

/**
 * Silver extracted-fields cache. Keyed by (brand_id, field_key,
 * field_description_hash[, campaign_id]) so two callers asking for the same
 * `field_key` with different prompt descriptions resolve to distinct rows.
 */
export const brandExtractedFields = pgTable("brand_extracted_fields", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	brandId: uuid("brand_id").notNull(),
	fieldKey: text("field_key").notNull(),
	fieldDescription: text("field_description").notNull().default(''),
	fieldDescriptionHash: text("field_description_hash").notNull().default(sql`md5('')`),
	fieldValue: jsonb("field_value"),
	sourceUrls: jsonb("source_urls"),
	campaignId: uuid("campaign_id"),
	extractedAt: timestamp("extracted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_extracted_fields_expires").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_extracted_fields_campaign").using("btree", table.campaignId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("idx_extracted_fields_brand_key_desc_no_campaign").on(table.brandId, table.fieldKey, table.fieldDescriptionHash).where(sql`${table.campaignId} IS NULL`),
	uniqueIndex("idx_extracted_fields_brand_key_desc_campaign").on(table.brandId, table.fieldKey, table.fieldDescriptionHash, table.campaignId).where(sql`${table.campaignId} IS NOT NULL`),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "brand_extracted_fields_brand_id_fkey"
		}).onDelete("cascade"),
]);

/**
 * Legacy `brand_extracted_fields_old`. Preserved as a safety net during the
 * silver/gold/bronze migration. New code MUST NOT read from this table.
 */
export const brandExtractedFieldsOld = pgTable("brand_extracted_fields_old", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	brandId: uuid("brand_id").notNull(),
	fieldKey: text("field_key").notNull(),
	fieldDescription: text("field_description").notNull().default(''),
	fieldDescriptionHash: text("field_description_hash").notNull().default(sql`md5('')`),
	fieldValue: jsonb("field_value"),
	sourceUrls: jsonb("source_urls"),
	campaignId: uuid("campaign_id"),
	extractedAt: timestamp("extracted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const pageScrapeCache = pgTable("page_scrape_cache", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	url: text().notNull(),
	normalizedUrl: text("normalized_url").notNull(),
	content: text().notNull(),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("page_scrape_cache_normalized_url_key").using("btree", table.normalizedUrl.asc().nullsLast().op("text_ops")),
	index("idx_page_scrape_cache_expires").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
]);

export const urlMapCache = pgTable("url_map_cache", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	siteUrl: text("site_url").notNull(),
	normalizedSiteUrl: text("normalized_site_url").notNull(),
	urls: jsonb().notNull().default([]),
	mappedAt: timestamp("mapped_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("url_map_cache_normalized_site_url_key").using("btree", table.normalizedSiteUrl.asc().nullsLast().op("text_ops")),
	index("idx_url_map_cache_expires").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
]);

export const scrapedUrlFirecrawl = pgTable("scraped_url_firecrawl", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	success: boolean(),
	returnCode: integer("return_code"),
	sourceUrl: text("source_url"),
	url: text().notNull(),
	scrapeId: text("scrape_id"),
	content: text(),
	markdown: text(),
	html: text(),
	rawHtml: text("raw_html"),
	links: text().array(),
	title: text(),
	description: text(),
	language: text(),
	languageCode: text("language_code"),
	countryCode: text("country_code"),
	favicon: text(),
	robots: text(),
	viewport: text(),
	template: text(),
	contentType: text("content_type"),
	ogTitle: text("og_title"),
	ogTitleAlt: text("og_title_alt"),
	ogDescription: text("og_description"),
	ogDescriptionAlt: text("og_description_alt"),
	ogType: text("og_type"),
	ogImage: text("og_image"),
	ogImageAlt: text("og_image_alt"),
	ogUrl: text("og_url"),
	ogUrlAlt: text("og_url_alt"),
	ogLocale: text("og_locale"),
	ogLocaleAlt: text("og_locale_alt"),
	searchTitle: text("search_title"),
	ibmComSearchAppid: text("ibm_com_search_appid"),
	ibmComSearchScopes: text("ibm_com_search_scopes"),
	ibmSearchFacetFieldHierarchy01: text("ibm_search_facet_field_hierarchy_01"),
	ibmSearchFacetFieldHierarchy03: text("ibm_search_facet_field_hierarchy_03"),
	ibmSearchFacetFieldKeyword01: text("ibm_search_facet_field_keyword_01"),
	ibmSearchFacetFieldText01: text("ibm_search_facet_field_text_01"),
	focusArea: text("focus_area"),
	siteSection: text("site_section"),
	dctermsDate: text("dcterms_date"),
	proxyUsed: text("proxy_used"),
	cacheState: text("cache_state"),
	cachedAt: timestamp("cached_at", { withTimezone: true, mode: 'string' }),
	pageStatusCode: integer("page_status_code"),
	summary: text(),
	screenshot: text(),
	actions: jsonb(),
	changeTracking: jsonb("change_tracking"),
	rawResponse: jsonb("raw_response"),
	warning: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	domain: text(),
	normalizedUrl: text("normalized_url").notNull(),
}, (table) => [
	index("idx_scraped_url_firecrawl_normalized_url").using("btree", table.normalizedUrl.asc().nullsLast().op("text_ops")),
	index().using("gin", table.actions.asc().nullsLast().op("jsonb_ops")),
	index("scraped_url_firecrawl_content_search_idx").using("gin", sql`to_tsvector('english'::regconfig, COALESCE(content, ''::text))`),
	index().using("btree", table.domain.asc().nullsLast().op("text_ops")),
	index("scraped_url_firecrawl_markdown_search_idx").using("gin", sql`to_tsvector('english'::regconfig, COALESCE(markdown, ''::text))`),
	uniqueIndex("scraped_url_firecrawl_normalized_url_key").using("btree", table.normalizedUrl.asc().nullsLast().op("text_ops")),
	index().using("btree", table.pageStatusCode.asc().nullsLast().op("int4_ops")),
	index().using("gin", table.rawResponse.asc().nullsLast().op("jsonb_ops")),
	index().using("btree", table.scrapeId.asc().nullsLast().op("text_ops")),
	index().using("btree", table.scrapedAt.asc().nullsLast().op("timestamptz_ops")),
	index().using("btree", table.sourceUrl.asc().nullsLast().op("text_ops")),
	index().using("btree", table.success.asc().nullsLast().op("bool_ops")),
	index().using("btree", table.url.asc().nullsLast().op("text_ops")),
]);

export const individualsLinkedinPosts = pgTable("individuals_linkedin_posts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	individualId: uuid("individual_id"),
	rawData: jsonb("raw_data").notNull(),
	postType: text("post_type").notNull(),
	linkedinPostId: text("linkedin_post_id").notNull(),
	linkedinUrl: text("linkedin_url").notNull(),
	content: text(),
	contentAttributes: jsonb("content_attributes"),
	author: jsonb(),
	authorName: text("author_name"),
	authorLinkedinUrl: text("author_linkedin_url"),
	postedAt: timestamp("posted_at", { withTimezone: true, mode: 'string' }),
	postedAtData: jsonb("posted_at_data"),
	postImages: jsonb("post_images"),
	hasImages: boolean("has_images").default(false),
	repostId: text("repost_id"),
	repostData: jsonb("repost_data"),
	isRepost: boolean("is_repost").default(false),
	socialContent: jsonb("social_content"),
	engagement: jsonb(),
	likesCount: integer("likes_count").default(0),
	commentsCount: integer("comments_count").default(0),
	sharesCount: integer("shares_count").default(0),
	impressionsCount: integer("impressions_count").default(0),
	reactions: jsonb(),
	comments: jsonb(),
	header: jsonb(),
	article: jsonb(),
	articleLink: text("article_link"),
	articleTitle: text("article_title"),
	hasArticle: boolean("has_article").default(false),
	input: jsonb(),
	query: jsonb(),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	authorAvatarUrl: text("author_avatar_url"),
	authorInfo: jsonb("author_info"),
	articleImageUrl: text("article_image_url"),
	articleDescription: text("article_description"),
}, (table) => [
	index().using("btree", table.authorLinkedinUrl.asc().nullsLast().op("text_ops")),
	index().using("gin", table.contentAttributes.asc().nullsLast().op("jsonb_ops")),
	index("individuals_linkedin_posts_content_search_idx").using("gin", sql`to_tsvector('english'::regconfig, content)`),
	index().using("gin", table.engagement.asc().nullsLast().op("jsonb_ops")),
	index().using("btree", table.individualId.asc().nullsLast().op("uuid_ops")),
	index().using("btree", table.isRepost.asc().nullsLast().op("bool_ops")),
	index().using("btree", table.linkedinPostId.asc().nullsLast().op("text_ops")),
	index().using("btree", table.postType.asc().nullsLast().op("text_ops")),
	index().using("btree", table.postedAt.asc().nullsLast().op("timestamptz_ops")),
	index().using("gin", table.rawData.asc().nullsLast().op("jsonb_ops")),
	index().using("gin", table.reactions.asc().nullsLast().op("jsonb_ops")),
	index().using("btree", table.repostId.asc().nullsLast().op("text_ops")),
	index().using("btree", table.scrapedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.individualId],
			foreignColumns: [individuals.id],
			name: "individuals_linkedin_posts_individual_id_fkey"
		}).onDelete("set null"),
	unique("individuals_linkedin_posts_linkedin_post_id_key").on(table.linkedinPostId),
]);

export const organizationIdeas = pgTable("organization_ideas", {
	sourceOrganizationId: integer("source_organization_id").primaryKey().generatedAlwaysAsIdentity({ name: "organization_ideas_source_organization_url_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	externalOrganizationId: text("external_organization_id"),
	organizationContrarianIdeas: json("organization_contrarian_ideas"),
});


export const intakeForms = pgTable("intake_forms", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	brandId: uuid("brand_id").notNull(),
	liveblocksRoomId: text("liveblocks_room_id"),
	nameAndTitle: text("name_and_title"),
	phoneAndEmail: text("phone_and_email"),
	websiteAndSocials: text("website_and_socials"),
	imagesLink: text("images_link"),
	startDate: date("start_date"),
	bio: text(),
	elevatorPitch: text("elevator_pitch"),
	guestPieces: text("guest_pieces"),
	interviewQuestions: text("interview_questions"),
	quotes: text(),
	talkingPoints: text("talking_points"),
	collateral: text(),
	howStarted: text("how_started"),
	whyStarted: text("why_started"),
	mission: text(),
	story: text(),
	previousJobs: text("previous_jobs"),
	offerings: text(),
	currentPromotion: text("current_promotion"),
	problemSolution: text("problem_solution"),
	futureOfferings: text("future_offerings"),
	location: text(),
	goals: text(),
	helpPeople: text("help_people"),
	categories: text(),
	pressTargeting: text("press_targeting"),
	pressType: text("press_type"),
	specificOutlets: text("specific_outlets"),
	status: text(),
	lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	generatingStartedAt: timestamp("generating_started_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index().using("btree", table.liveblocksRoomId.asc().nullsLast().op("text_ops")).where(sql`(liveblocks_room_id IS NOT NULL)`),
	index("intake_forms_organization_id_index").using("btree", table.brandId.asc().nullsLast().op("uuid_ops")),
	index().using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`(status IS NOT NULL)`),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "intake_forms_organization_id_fkey"
		}).onDelete("cascade"),
	unique("unique_org_intake").on(table.brandId),
	check("intake_forms_status_check", sql`(status IS NULL) OR (status = 'generating'::text)`),
]);

export const brandThesis = pgTable("brand_thesis", {
	id: serial().primaryKey().notNull(),
	brandId: uuid("brand_id").notNull(),
	thesisHtml: text("thesis_html").notNull(),
	contrarianLevel: integer("contrarian_level").notNull(),
	status: organizationIndividualThesisStatus().default('pending').notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
	thesisSupportingEvidenceHtml: text("thesis_supporting_evidence_html"),
	generatingStartedAt: timestamp("generating_started_at", { withTimezone: true, mode: 'string' }),
	statusReason: text("status_reason"),
	statusChangedByType: text("status_changed_by_type"),
	statusChangedByUserId: uuid("status_changed_by_user_id"),
	statusChangedAt: timestamp("status_changed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("organizations_aied_thesis_generating_started_at_index").using("btree", table.generatingStartedAt.asc().nullsLast().op("timestamptz_ops")),
	index("organizations_individuals_aied_thesis_contrarian_level_index").using("btree", table.contrarianLevel.asc().nullsLast().op("int4_ops")),
	index("organizations_individuals_aied_thesis_organization_id_index").using("btree", table.brandId.asc().nullsLast().op("uuid_ops")),
	index("organizations_individuals_aied_thesis_status_index").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "organizations_individuals_aied_thesis_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "organizations_aied_thesis_organization_id_fkey"
		}).onDelete("cascade"),
	unique("unique_org_level_thesis").on(table.brandId, table.thesisHtml, table.contrarianLevel),
	check("check_status_changed_by_type", sql`(status_changed_by_type = ANY (ARRAY['ai'::text, 'user'::text])) OR (status_changed_by_type IS NULL)`),
]);

export const drizzleMigrations = pgTable("__drizzle_migrations", {
	id: serial().primaryKey().notNull(),
	hash: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	createdAt: bigint("created_at", { mode: "number" }),
});

export const webPages = pgTable("web_pages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	url: text().notNull(),
	pageCategory: webPageCategoryEnum("page_category"),
	shouldScrape: boolean("should_scrape").default(true),
	domain: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	normalizedUrl: text("normalized_url").notNull(),
}, (table) => [
	index("idx_web_pages_domain").using("btree", table.domain.asc().nullsLast().op("text_ops")),
	index("idx_web_pages_should_scrape").using("btree", table.shouldScrape.asc().nullsLast().op("bool_ops")).where(sql`(should_scrape = true)`),
	index("idx_web_pages_url").using("btree", table.url.asc().nullsLast().op("text_ops")),
	uniqueIndex("web_pages_normalized_url_key").using("btree", table.normalizedUrl.asc().nullsLast().op("text_ops")),
]);

export const brandRelations = pgTable("brand_relations", {
	sourceBrandId: uuid("source_brand_id").notNull(),
	targetBrandId: uuid("target_brand_id").notNull(),
	relationType: organizationRelationType("relation_type").default('other').notNull(),
	relationConfidenceLevel: text("relation_confidence_level"),
	relationConfidenceRationale: text("relation_confidence_rationale"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	status: organizationRelationStatus().default('active').notNull(),
}, (table) => [
	index("organization_relations_status_index").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	foreignKey({
			columns: [table.sourceBrandId],
			foreignColumns: [brands.id],
			name: "organization_relations_source_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.targetBrandId],
			foreignColumns: [brands.id],
			name: "organization_relations_target_organization_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.sourceBrandId, table.targetBrandId], name: "organization_relations_pkey"}),
]);

export const brandIndividuals = pgTable("brand_individuals", {
	brandId: uuid("brand_id").notNull(),
	individualId: uuid("individual_id").notNull(),
	organizationRole: text("organization_role").notNull(),
	joinedOrganizationAt: timestamp("joined_organization_at", { withTimezone: true, mode: 'string' }),
	belongingConfidenceRationale: text("belonging_confidence_rationale").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	status: organizationIndividualStatus().default('active').notNull(),
	belongingConfidenceLevel: belongingConfidenceLevelEnum("belonging_confidence_level"),
}, (table) => [
	index("organization_individuals_individual_id_index").using("btree", table.individualId.asc().nullsLast().op("uuid_ops")),
	index("organization_individuals_organization_id_index").using("btree", table.brandId.asc().nullsLast().op("uuid_ops")),
	index("organization_individuals_status_index").using("btree", table.status.asc().nullsLast().op("enum_ops")),
	foreignKey({
			columns: [table.individualId],
			foreignColumns: [individuals.id],
			name: "organization_individuals_individual_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "organization_individuals_organization_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.brandId, table.individualId], name: "organization_individuals_pkey"}),
]);
/**
 * EIGHT LEGACY REPORTING VIEWS, DECLARED AS `.existing()` — drizzle does not
 * manage them and never creates them.
 *
 * Each one selects `o.external_organization_id` from `brands`, a column that
 * column no longer has: the silver/gold restructure (migrations 0024/0025)
 * renamed the old table aside and built a new `brands` without it. The views
 * survive in production bound to the table they were created against, so they
 * keep answering the legacy `/organizations/*` routes that query them by name
 * through raw SQL — but their recorded SQL cannot be replayed against the
 * schema this file describes. Asking `drizzle-kit push` to create them fails
 * (`column o.external_organization_id does not exist`), and because push
 * reports a failed statement and exits 0, that failure USED to pass silently:
 * CI built its schema on a database forked from production, where the views
 * already existed, so it never tried. Building from empty, it does.
 *
 * `.existing()` states the truth — this service reads them, it does not own
 * their shape. Restating them correctly means deciding what
 * `external_organization_id` means now, which is a product question, not a CI
 * one; the routes that read them have no test coverage today.
 */
export const vIndividualsLinkedinPosts = pgView("v_individuals_linkedin_posts", {	externalOrganizationId: text("external_organization_id"),
	postId: uuid("post_id"),
	individualId: uuid("individual_id"),
	individualName: text("individual_name"),
	linkedinPostId: text("linkedin_post_id"),
	linkedinUrl: text("linkedin_url"),
	postType: text("post_type"),
	content: text(),
	authorName: text("author_name"),
	authorLinkedinUrl: text("author_linkedin_url"),
	authorAvatarUrl: text("author_avatar_url"),
	authorInfo: jsonb("author_info"),
	articleImageUrl: text("article_image_url"),
	postedAt: timestamp("posted_at", { withTimezone: true, mode: 'string' }),
	likesCount: integer("likes_count"),
	commentsCount: integer("comments_count"),
	sharesCount: integer("shares_count"),
	impressionsCount: integer("impressions_count"),
	hasImages: boolean("has_images"),
	postImages: jsonb("post_images"),
	isRepost: boolean("is_repost"),
	repostId: text("repost_id"),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
}).existing();

export const vOrganizationScrapedPages = pgView("v_organization_scraped_pages", {	externalOrganizationId: text("external_organization_id"),
	id: uuid(),
	url: text(),
	domain: text(),
	title: text(),
	description: text(),
	content: text(),
	markdown: text(),
	hasContent: boolean("has_content"),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	pageCategory: webPageCategoryEnum("page_category"),
}).existing();

export const vIndividualsPersonalContent = pgView("v_individuals_personal_content", {	externalOrganizationId: text("external_organization_id"),
	scrapedId: uuid("scraped_id"),
	individualId: uuid("individual_id"),
	individualName: text("individual_name"),
	url: text(),
	domain: text(),
	title: text(),
	description: text(),
	content: text(),
	markdown: text(),
	hasContent: boolean("has_content"),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
}).existing();

export const vOrganizationLinkedinPosts = pgView("v_organization_linkedin_posts", {	externalOrganizationId: text("external_organization_id"),
	id: uuid(),
	linkedinPostId: text("linkedin_post_id"),
	linkedinUrl: text("linkedin_url"),
	postType: text("post_type"),
	content: text(),
	authorName: text("author_name"),
	authorLinkedinUrl: text("author_linkedin_url"),
	authorUniversalName: text("author_universal_name"),
	authorAvatarUrl: text("author_avatar_url"),
	authorInfo: jsonb("author_info"),
	articleImageUrl: text("article_image_url"),
	postedAt: timestamp("posted_at", { withTimezone: true, mode: 'string' }),
	likesCount: integer("likes_count"),
	commentsCount: integer("comments_count"),
	sharesCount: integer("shares_count"),
	impressionsCount: integer("impressions_count"),
	hasImages: boolean("has_images"),
	postImages: jsonb("post_images"),
	isRepost: boolean("is_repost"),
	repostId: text("repost_id"),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
}).existing();

export const vIndividualsLinkedinArticles = pgView("v_individuals_linkedin_articles", {	externalOrganizationId: text("external_organization_id"),
	postId: uuid("post_id"),
	individualId: uuid("individual_id"),
	individualName: text("individual_name"),
	linkedinPostId: text("linkedin_post_id"),
	linkedinUrl: text("linkedin_url"),
	postType: text("post_type"),
	content: text(),
	articleTitle: text("article_title"),
	articleLink: text("article_link"),
	articleImageUrl: text("article_image_url"),
	articleDescription: text("article_description"),
	article: jsonb(),
	authorName: text("author_name"),
	authorLinkedinUrl: text("author_linkedin_url"),
	authorAvatarUrl: text("author_avatar_url"),
	authorInfo: jsonb("author_info"),
	postedAt: timestamp("posted_at", { withTimezone: true, mode: 'string' }),
	likesCount: integer("likes_count"),
	commentsCount: integer("comments_count"),
	sharesCount: integer("shares_count"),
	impressionsCount: integer("impressions_count"),
	hasImages: boolean("has_images"),
	postImages: jsonb("post_images"),
	isRepost: boolean("is_repost"),
	repostId: text("repost_id"),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	scrapedId: uuid("scraped_id"),
	scrapedSourceUrl: text("scraped_source_url"),
	scrapedUrl: text("scraped_url"),
	scrapedDomain: text("scraped_domain"),
	scrapedTitle: text("scraped_title"),
	scrapedDescription: text("scraped_description"),
	scrapedContent: text("scraped_content"),
	scrapedMarkdown: text("scraped_markdown"),
	scrapedHtml: text("scraped_html"),
	scrapedRawHtml: text("scraped_raw_html"),
	scrapedLinks: text("scraped_links"),
	scrapedLanguage: text("scraped_language"),
	scrapedOgTitle: text("scraped_og_title"),
	scrapedOgDescription: text("scraped_og_description"),
	scrapedOgImage: text("scraped_og_image"),
	scrapedPageScrapedAt: timestamp("scraped_page_scraped_at", { withTimezone: true, mode: 'string' }),
	scrapedPageCreatedAt: timestamp("scraped_page_created_at", { withTimezone: true, mode: 'string' }),
	hasScrapedContent: boolean("has_scraped_content"),
}).existing();

export const vOrganizationLinkedinArticles = pgView("v_organization_linkedin_articles", {	externalOrganizationId: text("external_organization_id"),
	id: uuid(),
	linkedinPostId: text("linkedin_post_id"),
	linkedinUrl: text("linkedin_url"),
	postType: text("post_type"),
	content: text(),
	articleTitle: text("article_title"),
	articleLink: text("article_link"),
	articleImageUrl: text("article_image_url"),
	articleDescription: text("article_description"),
	article: jsonb(),
	authorName: text("author_name"),
	authorLinkedinUrl: text("author_linkedin_url"),
	authorUniversalName: text("author_universal_name"),
	authorAvatarUrl: text("author_avatar_url"),
	authorInfo: jsonb("author_info"),
	postedAt: timestamp("posted_at", { withTimezone: true, mode: 'string' }),
	likesCount: integer("likes_count"),
	commentsCount: integer("comments_count"),
	sharesCount: integer("shares_count"),
	impressionsCount: integer("impressions_count"),
	hasImages: boolean("has_images"),
	postImages: jsonb("post_images"),
	isRepost: boolean("is_repost"),
	repostId: text("repost_id"),
	scrapedAt: timestamp("scraped_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
	scrapedId: uuid("scraped_id"),
	scrapedSourceUrl: text("scraped_source_url"),
	scrapedUrl: text("scraped_url"),
	scrapedDomain: text("scraped_domain"),
	scrapedTitle: text("scraped_title"),
	scrapedDescription: text("scraped_description"),
	scrapedContent: text("scraped_content"),
	scrapedMarkdown: text("scraped_markdown"),
	scrapedHtml: text("scraped_html"),
	scrapedRawHtml: text("scraped_raw_html"),
	scrapedLinks: text("scraped_links"),
	scrapedLanguage: text("scraped_language"),
	scrapedOgTitle: text("scraped_og_title"),
	scrapedOgDescription: text("scraped_og_description"),
	scrapedOgImage: text("scraped_og_image"),
	scrapedPageScrapedAt: timestamp("scraped_page_scraped_at", { withTimezone: true, mode: 'string' }),
	scrapedPageCreatedAt: timestamp("scraped_page_created_at", { withTimezone: true, mode: 'string' }),
	hasScrapedContent: boolean("has_scraped_content"),
}).existing();

export const vOrganizationIndividuals = pgView("v_organization_individuals", {	externalOrganizationId: text("external_organization_id"),
	individualId: uuid("individual_id"),
	firstName: text("first_name"),
	lastName: text("last_name"),
	fullName: text("full_name"),
	linkedinUrl: text("linkedin_url"),
	personalWebsiteUrl: text("personal_website_url"),
	personalDomain: text("personal_domain"),
	pdlId: text("pdl_id"),
	pdlFullName: text("pdl_full_name"),
	pdlLocationName: text("pdl_location_name"),
	pdlJobTitle: text("pdl_job_title"),
	pdlJobCompanyName: text("pdl_job_company_name"),
	pdlJobCompanyIndustry: text("pdl_job_company_industry"),
	pdlLinkedinUrl: text("pdl_linkedin_url"),
	pdlJobCompanyWebsite: text("pdl_job_company_website"),
	pdlTwitterUrl: text("pdl_twitter_url"),
	pdlFacebookUrl: text("pdl_facebook_url"),
	pdlGithubUrl: text("pdl_github_url"),
	linkedinAuthorAvatarUrl: text("linkedin_author_avatar_url"),
	linkedinAuthorInfo: jsonb("linkedin_author_info"),
	relationCreatedAt: timestamp("relation_created_at", { withTimezone: true, mode: 'string' }),
	individualCreatedAt: timestamp("individual_created_at", { withTimezone: true, mode: 'string' }),
	relationshipStatus: organizationIndividualStatus("relationship_status"),
	organizationRole: text("organization_role"),
	joinedOrganizationAt: timestamp("joined_organization_at", { withTimezone: true, mode: 'string' }),
	belongingConfidenceLevel: belongingConfidenceLevelEnum("belonging_confidence_level"),
	belongingConfidenceRationale: text("belonging_confidence_rationale"),
}).existing();

export const vTargetOrganizations = pgView("v_target_organizations", {	sourceExternalOrganizationId: text("source_external_organization_id"),
	targetOrgId: uuid("target_org_id"),
	targetOrgExternalId: text("target_org_external_id"),
	targetOrgName: text("target_org_name"),
	targetOrgUrl: text("target_org_url"),
	targetOrgLinkedinUrl: text("target_org_linkedin_url"),
	targetOrgDomain: text("target_org_domain"),
	relationType: organizationRelationType("relation_type"),
	relationConfidenceLevel: text("relation_confidence_level"),
	relationConfidenceRationale: text("relation_confidence_rationale"),
	relationStatus: organizationRelationStatus("relation_status"),
	relationCreatedAt: timestamp("relation_created_at", { withTimezone: true, mode: 'string' }),
	relationUpdatedAt: timestamp("relation_updated_at", { withTimezone: true, mode: 'string' }),
	targetOrgLocation: text("target_org_location"),
	targetOrgBio: text("target_org_bio"),
	targetOrgElevatorPitch: text("target_org_elevator_pitch"),
	targetOrgMission: text("target_org_mission"),
	targetOrgStory: text("target_org_story"),
	targetOrgOfferings: text("target_org_offerings"),
	targetOrgProblemSolution: text("target_org_problem_solution"),
	targetOrgGoals: text("target_org_goals"),
	targetOrgCategories: text("target_org_categories"),
	targetOrgFoundedDate: date("target_org_founded_date"),
	targetOrgContactName: text("target_org_contact_name"),
	targetOrgContactEmail: text("target_org_contact_email"),
	targetOrgContactPhone: text("target_org_contact_phone"),
	targetOrgSocialMedia: jsonb("target_org_social_media"),
}).existing();

export const brandExtractedImages = pgTable("brand_extracted_images", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	brandId: uuid("brand_id").notNull(),
	categoryKey: text("category_key").notNull(),
	originalUrl: text("original_url").notNull(),
	permanentUrl: text("permanent_url").notNull(),
	description: text(),
	width: integer(),
	height: integer(),
	format: text(),
	sizeBytes: integer("size_bytes"),
	relevanceScore: numeric("relevance_score"),
	sourcePageUrl: text("source_page_url"),
	campaignId: uuid("campaign_id"),
	extractedAt: timestamp("extracted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_extracted_images_brand_category").using("btree", table.brandId.asc().nullsLast().op("uuid_ops"), table.categoryKey.asc().nullsLast().op("text_ops")),
	index("idx_extracted_images_expires").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_extracted_images_campaign").using("btree", table.campaignId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.brandId],
			foreignColumns: [brands.id],
			name: "brand_extracted_images_brand_id_fkey"
		}).onDelete("cascade"),
]);

export const consolidatedFieldCache = pgTable("consolidated_field_cache", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	cacheKey: text("cache_key").notNull(),
	fieldValues: jsonb("field_values").notNull(),
	brandIds: jsonb("brand_ids").notNull(),
	fieldKeys: jsonb("field_keys").notNull(),
	campaignId: uuid("campaign_id"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("consolidated_field_cache_key_idx").using("btree", table.cacheKey.asc().nullsLast().op("text_ops")),
	index("idx_consolidated_field_cache_expires").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
]);

export const brandTransfers = pgTable("brand_transfers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	brandId: uuid("brand_id").notNull(),
	sourceOrgId: uuid("source_org_id").notNull(),
	targetOrgId: uuid("target_org_id").notNull(),
	initiatedByUserId: uuid("initiated_by_user_id").notNull(),
	serviceResults: jsonb("service_results").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_brand_transfers_brand_id").using("btree", table.brandId.asc().nullsLast().op("uuid_ops")),
]);

// Deprecated: tasks, tasks_runs, tasks_runs_costs tables removed from schema.
// Run tracking is now handled by runs-service via src/lib/runs-client.ts.
// The physical tables still exist in the database but are no longer used.

/**
 * A brand's own colour palette, as the logo.dev Brand API reports it.
 *
 * IDENTITY, not per-org config: a palette belongs to the DOMAIN, so it is keyed
 * on `brand_id` alone (like `name` and `logo_url`) rather than on
 * `(org_id, brand_id)` — two orgs claiming one domain see the same colours
 * because there is only one set of colours to see.
 *
 * `colors` is a jsonb ARRAY OF HEX STRINGS in the order the provider gives them
 * (`["#000103","#ce2e36","#003366"]`). The consumer does its own selection, so
 * nothing here filters or ranks them. It stays NULL until the provider actually
 * answers with a palette — a null/absent row IS the answer "we have no colours
 * for this brand", which the dashboard falls back to its own charter on. No
 * colour is ever invented, defaulted or derived from anything but the provider.
 *
 * The remaining columns exist because the Brand endpoint is ASYNCHRONOUS: an
 * un-indexed domain answers `202 {"msg":"not found, looking up"}` and is queued
 * for indexing on logo.dev's side, so the palette can only be read on a LATER
 * call. That is why this is a queue and not a fetch-and-store: `status`
 * 'pending' is the retry cadence's work list, 'resolved' carries colours, and
 * 'unavailable' is terminal (attempts exhausted, or the provider indexed the
 * domain and has no palette for it).
 */
export const brandColors = pgTable("brand_colors", {
	brandId: uuid("brand_id").primaryKey().notNull(),
	/** Provider-ordered hex strings. NULL until a call actually returns a palette. */
	colors: jsonb().$type<string[]>(),
	/** pending = still to retrieve | resolved = colours held | unavailable = terminal, no colours. */
	status: text().default('pending').notNull(),
	/** Metered Brand-endpoint calls spent on this brand. Bounded by MAX_ATTEMPTS. */
	attempts: integer().default(0).notNull(),
	lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true, mode: 'string' }),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	foreignKey({
		columns: [table.brandId],
		foreignColumns: [brands.id],
		name: "brand_colors_brand_id_fkey"
	}).onDelete("cascade"),
	index("brand_colors_pending_idx").on(table.status, table.attempts),
	check("brand_colors_status_check", sql`${table.status} IN ('pending','resolved','unavailable')`),
]);

/**
 * One row per METERED logo.dev Brand-endpoint call.
 *
 * The Brand endpoint is billed against a SEPARATE prepaid credit grant (~100
 * calls/month on Community), it hard-fails 402 when the grant is exhausted, and
 * it exposes NO quota header — so there is no way to ASK how much is left. This
 * ledger is the meter we do not get from the vendor: the retry cadence counts
 * this month's rows before it spends anything and stops at its own budget, well
 * under the grant. It doubles as the audit trail for a call class that costs
 * real money and has no other trace.
 */
export const logoDevBrandCalls = pgTable("logo_dev_brand_calls", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	domain: text().notNull(),
	/** colors | pending | no_colors | exhausted | failed */
	outcome: text().notNull(),
	httpStatus: integer("http_status"),
	detail: text(),
	calledAt: timestamp("called_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("logo_dev_brand_calls_called_at_idx").on(table.calledAt),
]);
