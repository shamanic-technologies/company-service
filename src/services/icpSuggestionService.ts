/**
 * ICP suggestion service.
 *
 * Given a brand, asks chat-service (LLM) to write ONE natural-language line
 * describing the brand's PRINCIPAL ideal customer profile (ICP) as a precise
 * PROSPECTING FILTER — who to contact (job titles / seniority) AND which
 * companies (industry, headcount range, revenue range, and sharper signals like
 * tech stack / funding / hiring / buying-intent when relevant), in the style of
 * an Apollo search query. The model walks an Apollo-aligned dimension checklist
 * and includes only the dimensions that genuinely sharpen the segment. Seeded
 * from the brand's current brand-profile fields plus target-audience signals and
 * effective sales economics (when present). The result is a single one-line
 * string returned to the caller; NOTHING is persisted.
 *
 * Optionally the caller passes `existingIcps` (ICPs already found). When present,
 * the service returns a DISTINCT, complementary ICP that does not overlap any of
 * them — i.e. "given these, find another one".
 *
 * Cost lifecycle (Pattern A — chat-delegated org route): this service creates a
 * brand-service run (child of the caller's run) and forwards its own run.id to
 * chat-service, which is the terminal LLM caller and therefore owns BOTH the
 * affordability gate (402 on insufficient credit, propagated here) AND the actual
 * token-cost declaration on that child run. There is NO brand-service
 * pre-authorize. The run is marked completed/failed here.
 *
 * Fail-loud: malformed/unparseable LLM output, an empty brand profile, or a
 * chat-service error all throw — there is NO fallback to a fabricated/default ICP.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { chat } from '../lib/chat-client';
import type { OrgCaller } from '../lib/chat-client';
import { createRun, updateRun } from '../lib/runs-client';
import { db, brandExtractedFields } from '../db';
import { brandProfileService } from './brandProfileService';
import { salesEconomicsService } from './salesEconomicsService';

/**
 * Extracted-field keys that describe the brand's TARGET AUDIENCE. These are
 * deliberately EXCLUDED from the derived brand profile (audience is owned
 * elsewhere — see brandProfileService.EXCLUDED_FIELD_KEYS), but they are the two
 * most ICP-relevant signals the brand has, so the ICP suggester reads them
 * directly from the raw extracted fields and re-injects them into the LLM
 * context. The global exclusion is left untouched.
 */
const AUDIENCE_FIELD_KEYS = ['targetAudience', 'customerPainPoints'] as const;
type AudienceSignals = Partial<Record<(typeof AUDIENCE_FIELD_KEYS)[number], string | string[]>>;

/**
 * Profile-field keys DROPPED from the ICP context because they describe HOW the
 * offer is sold or the brand ITSELF — never WHO to prospect. Two families (see
 * the dashboard brand-profile field editor for the source vocabulary):
 *
 * - Conversion levers (the whole "Conversion levers" section): callToAction,
 *   perceivedLikelihood, urgency, scarcity, riskReversal. These are offer/value-
 *   equation copy — pure noise for a targeting filter.
 * - Brand-vanity self-description: leadership, funding, awardsAndRecognition,
 *   revenueMilestones. These describe the SELLER. Worse than noise: the system
 *   prompt asks the model for the PROSPECT's firmographics (target revenue range,
 *   funding stage), so the brand's OWN funding/revenue in the same flat JSON gets
 *   misread as prospect targeting criteria (e.g. "target companies that raised
 *   seed" leaking from the brand's own raise).
 *
 * Everything NOT listed here is kept (offer/targeting-relevant: companyOverview,
 * services, valueProposition, keyFeatures, productDifferentiators, competitors,
 * socialProof, industry, geography, additionalContext, …) — this is a denylist,
 * so new offer/targeting fields feed the prompt without a code change; only new
 * copy-lever / vanity fields need adding. Matched case-insensitively. `socialProof`
 * is deliberately KEPT (case studies / customer types sharpen the segment).
 */
const ICP_EXCLUDED_PROFILE_KEYS = new Set(
  [
    // Conversion / offer-copy levers
    'callToAction',
    'perceivedLikelihood',
    'urgency',
    'scarcity',
    'riskReversal',
    // Brand-vanity self-description (misattribution risk vs prospect firmographics)
    'leadership',
    'funding',
    'awardsAndRecognition',
    'revenueMilestones',
  ].map((k) => k.toLowerCase()),
);

/**
 * Curate the brand-profile fields down to the offer/targeting-relevant subset
 * that actually sharpens WHO to prospect — dropping the conversion-copy levers
 * and brand-vanity self-description fields (see ICP_EXCLUDED_PROFILE_KEYS). Pure;
 * denylist by lowercased key. Unit-tested via the built message.
 */
export function curateIcpProfileFields(
  fields: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const curated: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (ICP_EXCLUDED_PROFILE_KEYS.has(key.toLowerCase())) continue;
    curated[key] = value;
  }
  return curated;
}

/**
 * Raised when the brand has no profile content to seed generation from. The
 * route maps this to 422 (client-actionable: enrich the brand first), distinct
 * from a 502 generation failure.
 */
export class IcpSuggestionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcpSuggestionUnavailableError';
  }
}

const SYSTEM_PROMPT = [
  "You are a B2B go-to-market strategist defining a brand's Ideal Customer",
  'Profile (ICP). An ICP describes the BEST-FIT customer segment — the accounts',
  'that get the most value from the brand, are cheapest to win, and stay longest',
  '— NOT a generic audience.',
  '',
  'Your output reads like a PROSPECTING FILTER written as one natural sentence —',
  'the kind of precise targeting query a sales rep would build in Apollo: WHO to',
  'contact inside the company, AND which companies they work at. Vague audience',
  'descriptions ("companies that struggle with reporting") are a failure; a',
  'pinpointed filter ("VP Eng / CTOs at Series A–B B2B SaaS, 50–500 employees,',
  '$5M–$50M revenue, using AWS") is the goal.',
  '',
  'Walk the dimensions below and, FOR EACH ONE, ask yourself: "does specifying',
  'this actually sharpen THIS brand\'s best-fit segment?" Include only the',
  'dimensions that genuinely narrow the segment; SKIP the ones that are',
  'irrelevant or that you cannot infer with confidence. Do NOT force every',
  'dimension in — a short, sharp filter beats a long, padded one.',
  '',
  'WHO to contact (the person — always specify at least one of these):',
  '- Job titles: the roles that actually decide/champion (e.g. "Head of RevOps",',
  '  "VP Engineering", "Founder"). This is the single most important dimension.',
  '- Seniority level: founder / C-suite / VP / head / director / manager — when',
  '  the decision sits at a specific reporting level.',
  '- Person location: only when you target by where the person lives, not the HQ.',
  '',
  'WHICH companies (firmographics — specify the ones that predict fit):',
  '- Industry / vertical: almost always worth it (e.g. "B2B SaaS", "e-commerce").',
  '- Employee headcount, as a RANGE: e.g. "50–500 employees", when company size',
  '  predicts fit.',
  '- Annual revenue, as a RANGE: e.g. "$5M–$50M/yr", when budget/maturity matters.',
  '- Geography (company HQ): only when the brand sells to a bounded region.',
  '',
  'SHARPER SIGNALS (add ONLY when clearly relevant — these are what make an ICP',
  'feel hand-built rather than generic):',
  '- Technologies used: when the product integrates with or replaces a specific',
  '  tool (e.g. "running Salesforce", "on Shopify").',
  '- Funding / growth stage: recent raise, total funding, or stage (e.g.',
  '  "recently raised Series A") when fresh capital is a buying trigger.',
  '- Hiring signals: actively hiring for certain roles, or growing headcount —',
  '  when that growth is the trigger to buy.',
  '- Buying-intent angle (soft): what the ideal customer is actively researching',
  '  right now — the brand\'s category, the pain, or a competitor name (e.g.',
  '  "evaluating cold-email tools"). A timing/messaging signal, phrased in plain',
  '  words — do NOT invent a precise score.',
  '',
  'Also fold in WHAT pain or trigger makes them buy now (the specific problem',
  'this brand solves) and WHY they are best-fit, when it sharpens the segment.',
  '',
  'Rules for the description:',
  '- ONE sentence. Pack in the chosen dimensions densely, like a search query —',
  '  no preamble, no "the ideal customer is", just the filter itself. Never a',
  '  paragraph or multiple sentences.',
  '- Plain, everyday language a non-expert understands.',
  '- Express firmographics as RANGES with short scale abbreviations: "M" for',
  '  million, "$", "<", ">", en dashes for ranges (e.g. "$5M–$50M/yr revenue",',
  '  "50–500 employees").',
  '- NO jargon acronyms — never write ACV, LTV, TAM, SAM, MQL, ICP, etc. Say it',
  '  in plain words instead. (Common job-title abbreviations like CTO/CEO/VP are',
  '  fine — those name the person.)',
  '',
  'If a list of ICPs already found is provided, return a DISTINCT, complementary',
  'ICP — a NEW segment that does NOT overlap any of the ones given.',
  '',
  'Return ONLY valid JSON of the exact form: { "icp": string }',
].join('\n');

/**
 * Read the brand's target-audience signals (targetAudience, customerPainPoints)
 * straight from the raw extracted fields. These are excluded from the derived
 * brand profile but are highly ICP-relevant, so the suggester injects them
 * explicitly. Org-level rows only (campaignId NULL), matching the virtual-v1
 * profile derivation.
 */
async function getAudienceSignals(brandId: string): Promise<AudienceSignals> {
  const rows = await db
    .select({ fieldKey: brandExtractedFields.fieldKey, fieldValue: brandExtractedFields.fieldValue })
    .from(brandExtractedFields)
    .where(and(eq(brandExtractedFields.brandId, brandId), isNull(brandExtractedFields.campaignId)));

  const signals: AudienceSignals = {};
  for (const { fieldKey, fieldValue } of rows) {
    if (!(AUDIENCE_FIELD_KEYS as readonly string[]).includes(fieldKey)) continue;
    if (typeof fieldValue === 'string') {
      if (fieldValue.trim().length === 0) continue;
      signals[fieldKey as keyof AudienceSignals] = fieldValue;
    } else if (Array.isArray(fieldValue)) {
      const items = fieldValue
        .filter((v) => v !== null && v !== undefined)
        .map((v) => String(v))
        .filter((v) => v.trim().length > 0);
      if (items.length > 0) signals[fieldKey as keyof AudienceSignals] = items;
    }
  }
  return signals;
}

export function buildMessage(
  profileFields: Record<string, string | string[]>,
  audienceSignals: AudienceSignals,
  economics: { economics: unknown; source: string | null },
  existingIcps: string[],
): string {
  // Only the offer/targeting-relevant fields reach the model — conversion-copy
  // levers and brand-vanity self-description are dropped here (single source of
  // truth for what enters the "Brand profile" context). The dedicated
  // audience-signal + economics blocks below are untouched.
  const curatedProfile = curateIcpProfileFields(profileFields);

  const audienceBlock =
    Object.keys(audienceSignals).length === 0
      ? 'No explicit target-audience signals on record.'
      : `Target-audience signals (from the brand's own extracted data):\n${JSON.stringify(audienceSignals, null, 2)}`;

  const economicsBlock =
    economics.economics === null
      ? 'No sales economics on record.'
      : `Effective sales economics (source: ${economics.source}):\n${JSON.stringify(economics.economics, null, 2)}`;

  const existingBlock =
    existingIcps.length === 0
      ? 'No ICPs found yet — return the single principal ICP.'
      : [
          'ICPs already found (return a DISTINCT, complementary new one — do NOT',
          'repeat or overlap any of these):',
          ...existingIcps.map((icp) => `- ${icp}`),
        ].join('\n');

  return [
    'Brand profile:',
    JSON.stringify(curatedProfile, null, 2),
    '',
    audienceBlock,
    '',
    economicsBlock,
    '',
    existingBlock,
    '',
    'Return the ICP as JSON: { "icp": string }',
  ].join('\n');
}

function extractJson(content: string): unknown {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('[brand-service] ICP suggestion failed: response was not JSON');
  }
  return JSON.parse(match[0]);
}

/**
 * Parse the LLM result into a single validated ICP string. Pure — unit-tested in
 * isolation. Throws on malformed output or an empty ICP (fail-loud; never returns
 * a fabricated default).
 */
export function parseIcp(raw: unknown): string {
  const icp =
    raw && typeof raw === 'object' ? (raw as { icp?: unknown }).icp : undefined;

  if (typeof icp !== 'string' || icp.trim().length === 0) {
    throw new Error(
      '[brand-service] ICP suggestion failed: model output did not contain a non-empty "icp" string',
    );
  }

  return icp.trim();
}

export interface SuggestIcpOptions {
  brandId: string;
  /** ICPs already found — the result must be DISTINCT from these. */
  existingIcps: string[];
  /** Org-scoped caller. `runId` (if any) is the upstream run — used as parent. */
  caller: OrgCaller;
  /**
   * WHICH offer to prospect for. Who to contact follows from what is being
   * sold, so a brand selling two things has two ICPs and the caller names which
   * one it is asking about. Omitted → the brand's sole offer, and the
   * deliberate 409 when it holds several and nobody named one.
   */
  offerId?: string | null;
}

export async function suggestIcp(opts: SuggestIcpOptions): Promise<string> {
  const { brandId, existingIcps, caller } = opts;

  // 1. Seed context from existing brand data (no persistence happens here).
  const profile = await brandProfileService.getByBrandId(caller.orgId, brandId, opts.offerId);
  const profileFields = profile.current.fields;
  // Fail loud when there is nothing OFFER/TARGETING-relevant to seed from — an
  // empty profile OR one carrying only conversion-copy / brand-vanity fields
  // (which are dropped from the ICP context) cannot define who to prospect.
  if (Object.keys(curateIcpProfileFields(profileFields)).length === 0) {
    throw new IcpSuggestionUnavailableError(
      `[brand-service] Cannot suggest an ICP for brand ${brandId}: brand profile has no offer/targeting fields to seed from`,
    );
  }
  const audienceSignals = await getAudienceSignals(brandId);
  const economics = await salesEconomicsService.getEffectiveByBrandId(caller.orgId, brandId);

  // 2. Create a brand-service run as a child of the caller's run.
  const run = await createRun({
    orgId: caller.orgId,
    userId: caller.userId || undefined,
    brandId,
    campaignId: caller.campaignId,
    featureSlug: caller.featureSlug,
    workflowSlug: caller.workflowSlug,
    audienceId: caller.audienceId,
    serviceName: 'brand-service',
    taskName: 'icp-suggestion',
    parentRunId: caller.runId || undefined,
  });

  // Forward OUR run.id to chat-service so the chat run (and its actual token
  // cost) nests under this brand-service run.
  const chatCaller: OrgCaller = { ...caller, runId: run.id };

  const identity = {
    orgId: caller.orgId,
    userId: caller.userId || undefined,
    runId: run.id,
    campaignId: caller.campaignId,
    featureSlug: caller.featureSlug,
    brandIdHeader: caller.brandIdHeader,
    workflowSlug: caller.workflowSlug,
    audienceId: caller.audienceId,
  };

  try {
    const result = await chat(
      {
        systemPrompt: SYSTEM_PROMPT,
        message: buildMessage(profileFields, audienceSignals, economics, existingIcps),
        provider: 'google',
        // flash-pro (Gemini 3.5 Flash, mid-tier) — stronger segmentation
        // reasoning than flash for sharper ICP relevance.
        model: 'flash-pro',
        responseFormat: 'json',
        // Low temperature for precise, deterministic segment selection. The
        // "DISTINCT from existingIcps" instruction (not sampling noise) drives a
        // complementary segment on follow-up calls.
        temperature: 0.1,
        maxTokens: 512,
        // Short one-line JSON ICP — no funnel-of-thought needed. Minimizes
        // Gemini's internal reasoning (flash-pro → `minimal`) for a faster reply.
        disableThinking: true,
      },
      chatCaller,
    );

    const raw = result.json ?? extractJson(result.content);
    const icp = parseIcp(raw);

    await updateRun(run.id, 'completed', identity);
    return icp;
  } catch (error) {
    try {
      await updateRun(run.id, 'failed', identity);
    } catch (err) {
      console.warn(`[brand-service] Failed to mark icp-suggestion run ${run.id} as failed:`, err);
    }
    throw error;
  }
}
