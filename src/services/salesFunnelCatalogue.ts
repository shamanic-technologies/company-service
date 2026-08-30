/**
 * The catalogue of sales funnels a brand can sell through.
 *
 * A funnel is ONE funnel, from the event that STARTS it down to the SALE. It owns
 * everything that funnel needs priced: the conversion rate of each of its steps,
 * the lifetime revenue of a client won through it, the page an outreach click
 * lands on and, when a meeting sits in the funnel, a booking link.
 *
 * VOCABULARY (owner-fixed): the terminal outcome of every funnel is a SALE —
 * it is what the customer buys. Each intermediate stage is a STEP. The step a
 * funnel is NAMED after is its MILESTONE. The word "outcome" is deprecated
 * fleet-wide: it used to name the retired per-brand optimization goal.
 *
 * brand-service OWNS this catalogue because it owns what a brand declares. The
 * dashboard renders the same funnels (`apps/dashboard/src/lib/sales-funnels.ts`
 * in `shamanic-technologies/distribute.you`) — the keys, the funnels and the steps
 * are byte-equal with it on purpose, so the screen and the store describe one
 * model rather than two that drift.
 *
 * THE FUNNEL IS THE WHOLE VOCABULARY. A funnel used to carry a `goal` beside its
 * key, and that goal is retired: it was strictly the poorer word, because
 * `sales_meetings_from_conversation` and `sales_meetings_from_website` both mapped
 * onto one `meetingBooked`, so a meeting won from a reply and one won on the
 * website were the same thing to every consumer and could not be priced apart.
 * A funnel key is what every read now answers with, and nothing else. Goal
 * spellings are still ACCEPTED on write, forever — see `src/lib/goal-vocabulary.ts`,
 * which exists for that and for nothing else.
 */

/**
 * The funnels in the catalogue. Wire values.
 *
 * These tokens are an owner decision and are the ONLY names the fleet uses for
 * what a brand sells through. The pre-retirement spellings (`reply_meeting`,
 * `visit_meeting`, `visit_signup`, `visit_form`) are accepted on WRITE forever —
 * `toSalesFunnelKey` resolves them — and are never emitted again.
 *
 * The first four are the original catalogue, written while cold email was the
 * only channel we ran: every journey began either in a conversation we started
 * or on the brand's own website. The last three describe journeys that begin
 * somewhere else entirely, and exist because roughly thirty acquisition channels
 * are opening. They are ADDED, never renamed over the four: live brands and live
 * budgets reference those keys.
 */
export const SALES_FUNNEL_KEYS = [
  'sales_meetings_from_conversation',
  'sales_meetings_from_website',
  'website_purchases',
  'form_magnet',
  'sales_from_conversation',
  'sales_meetings_from_ads',
  'lead_forms_from_ads',
] as const;

export type SalesFunnelKey = (typeof SALES_FUNNEL_KEYS)[number];

/**
 * The event that STARTS a funnel. A consumer reads this to decide which
 * acquisition channels can even feed which funnels: a channel that can only
 * produce a phone conversation cannot feed a funnel that starts at a website
 * visit, and a channel that never touches the brand's site cannot feed one that
 * starts there.
 *
 * - `conversation_reply` — somebody answered a conversation we started.
 * - `website_visit`      — somebody landed on the brand's OWN site.
 * - `ad_click`           — somebody engaged with an ad and stayed on the
 *                          advertising platform: a platform-hosted lead form
 *                          (Meta Lead Ads, LinkedIn Lead Gen Forms, TikTok lead
 *                          forms) or a booking taken straight from the ad (Meta
 *                          "Book Now", Google Local Services). The brand's own
 *                          site is never touched, which is exactly what makes
 *                          this a third starting situation rather than a visit.
 */
export const SALES_FUNNEL_START_EVENTS = [
  'conversation_reply',
  'website_visit',
  'ad_click',
] as const;

export type SalesFunnelStartEvent = (typeof SALES_FUNNEL_START_EVENTS)[number];

/**
 * Every funnel spelling a caller may still send, besides the four canonical ones.
 *
 * ACCEPTED FOREVER. A caller sending yesterday's word keeps working — that is
 * what made the rename safe to do without any consumer changing in lockstep.
 * They are NEVER emitted: every read answers with the canonical key.
 */
export const LEGACY_SALES_FUNNEL_KEYS = {
  reply_meeting: 'sales_meetings_from_conversation',
  visit_meeting: 'sales_meetings_from_website',
  visit_signup: 'website_purchases',
  visit_form: 'form_magnet',
} as const satisfies Record<string, SalesFunnelKey>;

export type LegacySalesFunnelKey = keyof typeof LEGACY_SALES_FUNNEL_KEYS;

/** Every funnel spelling accepted on write: every canonical key + every legacy one. */
export const ACCEPTED_SALES_FUNNEL_KEYS = [
  ...SALES_FUNNEL_KEYS,
  ...(Object.keys(LEGACY_SALES_FUNNEL_KEYS) as LegacySalesFunnelKey[]),
] as const;

export type AcceptedSalesFunnelKey = SalesFunnelKey | LegacySalesFunnelKey;

/**
 * Every rate a funnel can price. Named exactly as the columns that store them.
 * `meetingBookedToAttendedPct` — the meeting show-up rate — exists ONLY on
 * `brand_sales_funnels`; the other seven share a name with the brand-wide
 * `brand_sales_economics` columns but are stored PER FUNNEL here and are not
 * read from, or written to, that table.
 */
export const SALES_FUNNEL_RATE_KEYS = [
  'replyToMeetingPct',
  'visitToMeetingPct',
  'meetingBookedToAttendedPct',
  'meetingToClosePct',
  'visitToSignupPct',
  'signupToPaidClientPct',
  'visitToFormSubmissionPct',
  'formSubmissionToPaidClientPct',
  // The funnels that begin somewhere other than a conversation-with-a-meeting or
  // the brand's own website. None of these has a counterpart on the brand-wide
  // `brand_sales_economics` record — that record predates them — so they are
  // stated on the funnel or not at all.
  'replyToPaidClientPct',
  'adClickToMeetingPct',
  'adClickToLeadFormPct',
  'leadFormToPaidClientPct',
] as const;

export type SalesFunnelRateKey = (typeof SALES_FUNNEL_RATE_KEYS)[number];

export interface SalesFunnelDef {
  key: SalesFunnelKey;
  /** What the funnel is called. */
  name: string;
  /**
   * The event that STARTS this funnel. `steps[0]` is that event as a label; this
   * is the token a consumer matches a channel against.
   */
  startEvent: SalesFunnelStartEvent;
  /** The funnel. `legs[i]` is the rate between `steps[i]` and `steps[i + 1]`. */
  steps: string[];
  /** The rate each leg of the funnel converts at, in funnel order. */
  legs: SalesFunnelRateKey[];
  /**
   * The step this funnel is NAMED after — its MILESTONE. The moment that tells a
   * brand the funnel is working, which for most funnels lands before any sale has
   * happened. It is what a channel's minimum budget is priced against: one month
   * must pay for at least one of these. MUST be one of `steps`; the assertion at
   * the bottom of this file refuses a catalogue where it is not.
   *
   * A funnel whose only stage IS the sale (`sales_from_conversation`) names the
   * sale, because that is genuinely the moment it is named after — not a
   * fallback, and never a step borrowed from another funnel.
   */
  milestoneStep: string;
  /** The first step is a click onto the brand's site, so a domain is required. */
  requiresWebsite: boolean;
  /** This funnel lands an outreach click on a page of the brand's own site. */
  pageDestination: boolean;
  /** A meeting sits in the funnel, so a booking link is worth collecting. */
  bookingLink: boolean;
}

/**
 * The terminal step of every funnel is the SALE. Its LABEL is `Paid client` for
 * every funnel, old and new: the four original funnels have carried that label
 * since before the sale/step/milestone vocabulary was fixed, live consumers
 * render it, and a new funnel spelling the same stage differently would describe
 * one model as two.
 */
export const SALES_FUNNELS: SalesFunnelDef[] = [
  {
    key: 'sales_meetings_from_conversation',
    name: 'Sales Meeting from Conversation',
    startEvent: 'conversation_reply',
    steps: ['Positive reply', 'Meeting booked', 'Meeting attended', 'Paid client'],
    legs: ['replyToMeetingPct', 'meetingBookedToAttendedPct', 'meetingToClosePct'],
    milestoneStep: 'Meeting booked',
    requiresWebsite: false,
    pageDestination: false,
    bookingLink: true,
  },
  {
    key: 'sales_meetings_from_website',
    name: 'Sales Meeting from Website',
    startEvent: 'website_visit',
    steps: ['Website visit', 'Meeting booked', 'Meeting attended', 'Paid client'],
    legs: ['visitToMeetingPct', 'meetingBookedToAttendedPct', 'meetingToClosePct'],
    milestoneStep: 'Meeting booked',
    requiresWebsite: true,
    pageDestination: true,
    bookingLink: true,
  },
  {
    key: 'website_purchases',
    name: 'Website Purchase',
    startEvent: 'website_visit',
    steps: ['Website visit', 'Signup', 'Paid client'],
    legs: ['visitToSignupPct', 'signupToPaidClientPct'],
    milestoneStep: 'Signup',
    requiresWebsite: true,
    pageDestination: true,
    bookingLink: false,
  },
  {
    key: 'form_magnet',
    name: 'Form Magnet',
    startEvent: 'website_visit',
    steps: ['Website visit', 'Form filled', 'Paid client'],
    legs: ['visitToFormSubmissionPct', 'formSubmissionToPaidClientPct'],
    milestoneStep: 'Form filled',
    requiresWebsite: true,
    pageDestination: true,
    bookingLink: false,
  },
  {
    // The sale closes INSIDE the conversation — no meeting is ever booked. The
    // common shape under roughly two thousand dollars (agencies, freelancers,
    // wholesale) and the default in markets where business runs on WhatsApp.
    // Its milestone IS the sale, because the funnel has no stage before it; that
    // is the moment the funnel is named after, not a stand-in for a missing one.
    key: 'sales_from_conversation',
    name: 'Sale from Conversation',
    startEvent: 'conversation_reply',
    steps: ['Positive reply', 'Paid client'],
    legs: ['replyToPaidClientPct'],
    milestoneStep: 'Paid client',
    requiresWebsite: false,
    pageDestination: false,
    bookingLink: false,
  },
  {
    // A meeting booked DIRECTLY from an ad — Meta "Book Now", Google Local
    // Services — without the buyer ever visiting the brand's site. It shares the
    // show-up and close legs with the other meeting funnels, because once a
    // meeting is booked the rest of the journey is the same; only its first leg
    // is its own.
    key: 'sales_meetings_from_ads',
    name: 'Sales Meeting from Ads',
    startEvent: 'ad_click',
    steps: ['Ad click', 'Meeting booked', 'Meeting attended', 'Paid client'],
    legs: ['adClickToMeetingPct', 'meetingBookedToAttendedPct', 'meetingToClosePct'],
    milestoneStep: 'Meeting booked',
    requiresWebsite: false,
    pageDestination: false,
    bookingLink: true,
  },
  {
    // A form hosted BY THE ADVERTISING PLATFORM — Meta Lead Ads, LinkedIn Lead
    // Gen Forms, TikTok lead forms — which the buyer fills without ever touching
    // the brand's site. Deliberately GENERAL: the same funnel prices a webinar
    // signup, a guide download, a quote request and a demo request, so naming it
    // after any one of them would exclude the others.
    key: 'lead_forms_from_ads',
    name: 'Lead Form from Ads',
    startEvent: 'ad_click',
    steps: ['Ad click', 'Lead form submitted', 'Paid client'],
    legs: ['adClickToLeadFormPct', 'leadFormToPaidClientPct'],
    milestoneStep: 'Lead form submitted',
    requiresWebsite: false,
    pageDestination: false,
    bookingLink: false,
  },
];

export function isSalesFunnelKey(value: string): value is SalesFunnelKey {
  return (SALES_FUNNEL_KEYS as readonly string[]).includes(value);
}

export function isLegacySalesFunnelKey(value: string): value is LegacySalesFunnelKey {
  return Object.prototype.hasOwnProperty.call(LEGACY_SALES_FUNNEL_KEYS, value);
}

/** True for any spelling a caller may send — canonical or legacy. */
export function isAcceptedSalesFunnelKey(value: string): value is AcceptedSalesFunnelKey {
  return isSalesFunnelKey(value) || isLegacySalesFunnelKey(value);
}

/**
 * Resolve any accepted spelling to its canonical key. Returns null for a word
 * that names no funnel — the caller answers 400 rather than guessing one.
 */
export function toSalesFunnelKey(value: string): SalesFunnelKey | null {
  if (isSalesFunnelKey(value)) return value;
  if (isLegacySalesFunnelKey(value)) return LEGACY_SALES_FUNNEL_KEYS[value];
  return null;
}

/** The definition for a key. Throws on an unknown key — never guesses one. */
export function salesFunnelByKey(key: SalesFunnelKey): SalesFunnelDef {
  const def = SALES_FUNNELS.find((f) => f.key === key);
  if (!def) throw new Error(`Unknown sales funnel: ${key}`);
  return def;
}

/** The rates this funnel prices, in funnel order, deduped across repeated legs. */
export function funnelRateKeys(def: SalesFunnelDef): SalesFunnelRateKey[] {
  const seen = new Set<SalesFunnelRateKey>();
  const out: SalesFunnelRateKey[] = [];
  for (const leg of def.legs) {
    if (seen.has(leg)) continue;
    seen.add(leg);
    out.push(leg);
  }
  return out;
}

/** True when this funnel's funnel converts at `rate`. */
export function funnelPricesRate(def: SalesFunnelDef, rate: SalesFunnelRateKey): boolean {
  return def.legs.includes(rate);
}

/**
 * Where the MILESTONE sits in the funnel. Throws when the funnel names a step it
 * does not have — a consumer pricing a channel's minimum budget against a step
 * that is not in the funnel would be pricing nothing, so this fails loud rather
 * than answering 0 (which is a real position: the starting event).
 */
export function funnelMilestoneStepIndex(def: SalesFunnelDef): number {
  const index = def.steps.indexOf(def.milestoneStep);
  if (index < 0) {
    throw new Error(
      `Sales funnel "${def.key}" names milestone step "${def.milestoneStep}", which is not one of its steps: ` +
      def.steps.join(' -> ')
    );
  }
  return index;
}

/**
 * The catalogue is checked once, at load.
 *
 * Both new fields have to resolve for EVERY funnel or a consumer cannot answer
 * the two questions they exist for — which channels can feed this funnel, and
 * what does one month of that channel have to pay for. A funnel that cannot
 * answer them must break the service at boot, where it is one obvious error,
 * rather than at read time on whichever brand happens to have declared it.
 */
for (const def of SALES_FUNNELS) {
  if (!(SALES_FUNNEL_START_EVENTS as readonly string[]).includes(def.startEvent)) {
    throw new Error(`Sales funnel "${def.key}" declares an unknown start event: ${def.startEvent}`);
  }
  if (def.steps.length < 2) {
    throw new Error(`Sales funnel "${def.key}" has no funnel: a funnel runs from its start event to the sale.`);
  }
  if (def.legs.length !== def.steps.length - 1) {
    throw new Error(
      `Sales funnel "${def.key}" has ${def.steps.length} steps and ${def.legs.length} legs: ` +
      'every step but the first is reached through exactly one rate.'
    );
  }
  if ((def.startEvent === 'website_visit') !== def.requiresWebsite) {
    throw new Error(
      `Sales funnel "${def.key}" starts at ${def.startEvent} but ${def.requiresWebsite ? 'requires' : 'does not require'} a website.`
    );
  }
  funnelMilestoneStepIndex(def);
}

/**
 * ONE ARROW of a funnel: the two steps it connects, and the NAMED rate the
 * catalogue happens to price it with today.
 *
 * An arrow is identified by its two step LABELS, not by a name from a closed
 * list. That is what lets a brand state a rate for an arrow brand-service does
 * not know about — a funnel gaining a step (a phone call placed between a
 * positive reply and a booked meeting) creates arrows no `SalesFunnelRateKey`
 * names, and no column, no enum and no fleet-wide rename is needed for a brand
 * to price them.
 *
 * `rateKey` is the LEGACY named rate for this arrow, present only for the arrows
 * the catalogue already prices. It is what makes the two vocabularies reconcile
 * on read: an arrow with no stated rate falls back to it, so nothing a consumer
 * reads today changes.
 */
export interface SalesFunnelArrow {
  fromStep: string;
  toStep: string;
  rateKey: SalesFunnelRateKey;
}

/**
 * The arrows of this funnel, in funnel order. `legs[i]` is the rate between
 * `steps[i]` and `steps[i + 1]`, which the load-time check above already
 * guarantees is a total mapping.
 */
export function funnelArrows(def: SalesFunnelDef): SalesFunnelArrow[] {
  return def.legs.map((rateKey, i) => ({
    fromStep: def.steps[i],
    toStep: def.steps[i + 1],
    rateKey,
  }));
}
