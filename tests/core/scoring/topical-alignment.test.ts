/**
 * Batch B1+B2: topical alignment unit tests + recall-confidence integration.
 *
 * Covers:
 * - parseQueryTopic pattern families (what/which + does, bare did, where,
 *   possessive, of-phrases, who-identity, who-verb, identity single token)
 * - parseMemoryTopic declarative forms (birthplace/phone/location/employer)
 * - attribute bucket normalization (device->phone, resides->location,
 *   born->birthplace distinct from location)
 * - topicalAlignment truth table (1 / 0.7 / 0 / null)
 * - computeRecallConfidence: mismatch discounts AFTER agreement so bonuses
 *   cannot resurrect trust; null alignment is byte-neutral vs baseline
 * - assessRecall: mismatch-penalized best confidence flips the verdict to
 *   no_reliable_memory
 * - honest evidence assembly: absent query topic -> alignment stays null
 *
 * Integration (temp-dir SQLite, same isolation as other integration tests):
 * - seed only a birth record for Kenji -> phone query must abstain
 * - seed the actual phone fact -> phone query becomes confident and the
 *   iPhone memory carries the highest recall confidence
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';

import {
  parseQueryTopic,
  parseMemoryTopic,
  topicalAlignment,
  topicsAboutSameEntity,
  TOPIC_ATTRIBUTE_BUCKETS,
  CONTENT_DETECTABLE_BUCKETS,
  contentCarriesAttributeBucket,
  type QueryTopic,
} from '../../../core/scoring/topical-alignment.js';
import {
  RECALL_CONFIDENCE_CONSTANTS as C,
  DEFAULT_ABSTAIN_BELOW,
  computeRecallConfidence,
  assessRecall,
} from '../../../core/scoring/recall-confidence.js';
import { buildEvidence } from '../../../core/memory/search-evidence.js';
import { findRelationUnstated } from '../../../core/memory/search-evidence.js';
import type { RecallEvidence } from '../../../core/scoring/recall-confidence.js';

function makeEvidence(overrides: Partial<RecallEvidence> = {}): RecallEvidence {
  return {
    semantic: null,
    lexical: { rank: null, score: null },
    graph: null,
    temporal: { stale: null, supersededBy: null },
    conflictPenalty: null,
    memoryConfidence: null,
    supportingCount: 0,
    contradictingCount: 0,
    freshness: null,
    rerankAgreement: null,
    topicalAlignment: null,
    ...overrides,
  };
}

const HEALTHY_CTX = { candidateSemanticScores: [0.95, 0.6, 0.5], multiSignalQuery: false };
/** Decisive-but-unclamped context: neutral margin factor, >= MIN_COVERAGE_SET_SIZE candidates. */
const MARGIN_NEUTRAL_CTX = { candidateSemanticScores: [0.95, 0.8, 0.5], multiSignalQuery: false };

// ---------------------------------------------------------------------------
// Batch B12-4 lexicon buckets: city/location, family, mentorship
// ---------------------------------------------------------------------------

describe('city maps to location while hometown stays birthplace (B12-4 M1)', () => {
  it('parses settlement words in residence questions into location', () => {
    expect(TOPIC_ATTRIBUTE_BUCKETS).toContain('location');
    expect(parseQueryTopic('In which city does Tomas live?')).toEqual({ entity: 'tomas', attribute: 'location' });
    expect(parseQueryTopic('What city does Ivan live in?').attribute).toBe('location');
    expect(parseQueryTopic('Which town does June live near?').attribute).toBe('location');
  });

  it('NEGATIVE: hometown is an origin word and must NOT join the location bucket', () => {
    expect(parseQueryTopic('What is Priyas hometown?').attribute).toBe('birthplace');
    expect(parseQueryTopic("What is Priya's hometown?").attribute).toBe('birthplace');
    expect(parseQueryTopic('Where was Kenji born?').attribute).toBe('birthplace');
  });

  it('NEGATIVE: birth-context phrasing overrides city to birthplace inside family F', () => {
    // "What city was X born in?" asks ORIGIN, not residence.
    expect(parseQueryTopic('What city was Kenji born in?')).toEqual({ entity: 'kenji', attribute: 'birthplace' });
    const q = parseQueryTopic('In which city did Kenji grow up?');
    expect(q.attribute).toBe('birthplace');
    // And the two buckets stay distinct on the truth table.
    expect(topicalAlignment({ entity: 'kenji', attribute: 'location' }, { entity: 'kenji', attribute: 'birthplace' })).toBe(0);
  });
});

describe('family bucket for kinship relations (B12-4 M1)', () => {
  it('parses kinship-count terms into family', () => {
    expect(TOPIC_ATTRIBUTE_BUCKETS).toContain('family');
    expect(parseQueryTopic('How many siblings does Priya have?')).toEqual({ entity: 'priya', attribute: 'family' });
    expect(parseQueryTopic('Does Dmitri have siblings?').attribute).toBeNull(); // template gap stays null
    expect(parseQueryTopic('How many kids does Tomas have?').attribute).toBe('family');
    expect(parseQueryTopic('What family does Gustav have?').attribute).toBe('family');
  });

  it('kinship-identity words moved from name to family', () => {
    expect(parseQueryTopic('Who is Hanas brother?').attribute).toBe('person'); // who-template
    // Kinship words win attribute resolution over a trailing 'name' token.
    expect(parseQueryTopic('What is Hanas sisters name?').attribute).toBe('family');
    const q = parseQueryTopic('How many brothers does Kenji have?');
    expect(q.attribute).toBe('family');
  });

  it('NEGATIVE: marriage/parent words stay in the name bucket, not family', () => {
    expect(parseQueryTopic('What is Kwames wifes name?').attribute).toBe('name');
    expect(parseQueryTopic('What is Elenas mothers name?').attribute).toBe('name');
    expect(parseQueryTopic('What is Ivans husbands job?').attribute).not.toBe('family');
  });

  it('a car fact cannot answer a siblings question about the same person', () => {
    const q = parseQueryTopic('How many siblings does Priya have?');
    const m = parseMemoryTopic('Priya drives a 2019 Volvo V60.');
    expect(topicalAlignment(q, m)).toBe(0);
  });
});

describe('mentorship bucket distinct from employer (B12-4 M1)', () => {
  it('parses guide/overseer vocabulary into mentorship', () => {
    expect(TOPIC_ATTRIBUTE_BUCKETS).toContain('mentorship');
    expect(parseQueryTopic('Who mentors Fatima?')).toEqual({ entity: 'fatima', attribute: 'mentorship', entityRole: 'object' });
    expect(parseQueryTopic('Who manages Kenji?').attribute).toBe('mentorship');
    expect(parseQueryTopic('Who coaches Amara?').attribute).toBe('mentorship');
    // Memory-side vocabulary resolves through the same lexicon.
    expect(parseMemoryTopic('Amara hired a coach last spring.').attribute).toBe('mentorship');
    expect(parseMemoryTopic('Her supervisor approved the trip.').attribute).toBe('mentorship');
  });

  it('"reports to" carries mentorship as a phrase only', () => {
    expect(contentCarriesAttributeBucket('Zaid reports to the Porto office.', 'mentorship')).toBe(true);
  });

  it('NEGATIVE: who-is identity forms stay person, not the leading kinship/role noun', () => {
    expect(parseQueryTopic('Who is Fatimas supervisor?').attribute).toBe('person');
    expect(parseQueryTopic('Who is Priyas business partner?').attribute).toBe('person');
  });

  it('NEGATIVE: bare report/reports does NOT carry mentorship', () => {
    expect(contentCarriesAttributeBucket('Zaid reports quarterly numbers.', 'mentorship')).toBe(false);
    expect(contentCarriesAttributeBucket('The annual report was published.', 'mentorship')).toBe(false);
  });

  it('NEGATIVE: lookalike words must not join the bucket', () => {
    // "maintenance" shares letters with manage but must not resolve to it.
    expect(contentCarriesAttributeBucket('Network maintenance runs Saturday.', 'mentorship')).toBe(false);
    // manages reads mentorship, never employer.
    expect(contentCarriesAttributeBucket('She manages the Berlin accounts.', 'employer')).toBe(false);
  });

  it('an employer record is judged cannot-answer for a mentorship query', () => {
    const q = parseQueryTopic('Who mentors Fatima?');
    const m = parseMemoryTopic('Fatima is a pediatric nurse at St. Marys hospital.');
    // Memory-side attribute parses to null here - alignment stays neutral -
    // which is exactly why the presumed-relation-unstated scan exists.
    expect(m.attribute).toBeNull();
    expect(topicalAlignment(q, m)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Batch B12-4 query templates: families F, G, H + whoVerb verb attributes
// ---------------------------------------------------------------------------

describe('family F: preposition-led and past-framed attribute questions (B12-4)', () => {
  it('parses "[In] which <np> does <Entity> ..." questions', () => {
    expect(parseQueryTopic('At which hospital does Bruno work?')).toEqual({ entity: 'bruno', attribute: 'hospital' });
    expect(parseQueryTopic('On which day does Yara book client meetings?')).toEqual({ entity: 'yara', attribute: 'day' });
  });

  it('parses past-framed "What <np> was <Entity> ... ?" multi-hop questions', () => {
    expect(parseQueryTopic('In which city was Priyas car bought?')).toEqual({ entity: 'priyas', attribute: 'location' });
    expect(parseQueryTopic('In which city did Kenji buy his phone?')).toEqual({ entity: 'kenji', attribute: 'location' });
    expect(parseQueryTopic('What city was Kenjis phone bought in?').attribute).toBe('location');
  });

  it('returns honest nulls when no capitalized run follows the auxiliary', () => {
    expect(parseQueryTopic('What framework did the beacon service use throughout 2024?')).toEqual({
      entity: null,
      attribute: null,
    });
    expect(parseQueryTopic('What database did the atlas project use in early 2025?')).toEqual({
      entity: null,
      attribute: null,
    });
  });

  it('does not steal is/are forms from families D/E', () => {
    // E owns what-is forms with a leading entity.
    expect(parseQueryTopic('What is Fatimas favorite color?')).toEqual({ entity: 'fatima', attribute: 'color' });
    // F rejects aux-bearing questions whose tail has no capitalized run
    // (honest null, not a guess).
    expect(parseQueryTopic('What color was the old logo?')).toEqual({ entity: null, attribute: null });
  });
});

describe('family H: how many/much quantity questions (B12-4)', () => {
  it('parses quantity questions with a proper-noun subject', () => {
    expect(parseQueryTopic('How many siblings does Priya have?')).toEqual({ entity: 'priya', attribute: 'family' });
    expect(parseQueryTopic('How much salary does Ivan earn?')).toEqual({ entity: 'ivan', attribute: 'salary' });
  });

  it('stays null without a recognizable entity or outside many/much', () => {
    expect(parseQueryTopic('How many employees does the company have?')).toEqual({ entity: null, attribute: null });
    expect(parseQueryTopic('How has the GPU cluster size changed this year?')).toEqual({ entity: null, attribute: null });
  });
});

describe('family G: last-resort no-auxiliary what/which questions (B12-4)', () => {
  it('extracts the post-verb capitalized entity and verbatim attribute', () => {
    expect(parseQueryTopic('Which airline flies Qing to ensemble tours?')).toEqual({
      entity: 'qing',
      attribute: 'airline flies',
      entityRole: 'object',
    });
    expect(parseQueryTopic('Which marina takes Kwames fishing boat?').entity).toBe('kwames');
  });

  it('normalizes mapped attribute words before the entity', () => {
    expect(parseQueryTopic('Which team beats Kyoto United?').attribute).toBe('team');
  });

  it('refuses auxiliary-bearing questions entirely (families D/E own those shapes)', () => {
    // Guessing 'color' here would fabricate a mismatch against a legit
    // car-color answer; the honest result is null.
    expect(parseQueryTopic('What color is Kenjis car?')).toEqual({ entity: null, attribute: null });
    expect(parseQueryTopic('Which brand of coffee should we stock?')).toEqual({ entity: null, attribute: null });
    expect(parseQueryTopic('What happens to the staging database overnight?')).toEqual({ entity: null, attribute: null });
  });

  it('an instrument memory is judged mismatch for an airline question about Qing', () => {
    const q = parseQueryTopic('Which airline flies Qing to ensemble tours?');
    const m = parseMemoryTopic('Qing plays the erhu in a folk ensemble.');
    expect(topicalAlignment(q, m)).toBe(0);
  });
});

describe('whoVerb derives its attribute from the leading verb (B12-4)', () => {
  it('lexicon verbs become buckets; unknown verbs stay person queries', () => {
    expect(parseQueryTopic('Who mentors Fatima?')).toEqual({ entity: 'fatima', attribute: 'mentorship', entityRole: 'object' });
    expect(parseQueryTopic('Who leads Project Aurora?')).toEqual({ entity: 'project aurora', attribute: 'person', entityRole: 'object' });
    expect(parseQueryTopic('Who maintains the machines our training runs depend on?')).toEqual({
      entity: null,
      attribute: 'person',
    });
  });

  it('lives reads as location in who-questions', () => {
    expect(parseQueryTopic('Who lives next door to Greta?')).toEqual({ entity: 'greta', attribute: 'location', entityRole: 'object' });
  });
});

// ---------------------------------------------------------------------------
// Batch B12-4 content presence scan + presumed-relation-unstated signal
// ---------------------------------------------------------------------------

describe('contentCarriesAttributeBucket (B12-4)', () => {
  it('scans the FULL text, not just the first sentence keyword', () => {
    expect(contentCarriesAttributeBucket('Kenji was born in Osaka.', 'birthplace')).toBe(true);
    expect(contentCarriesAttributeBucket('Kenji was born in Osaka and lived there until twelve.', 'location')).toBe(true);
    expect(contentCarriesAttributeBucket('Priya drives a Volvo. She loves road trips.', 'car')).toBe(true);
  });

  it('is false when the bucket appears nowhere', () => {
    expect(contentCarriesAttributeBucket('Kenji was born in Osaka.', 'phone')).toBe(false);
    expect(contentCarriesAttributeBucket('', 'phone')).toBe(false);
  });

  it('respects phrase-level buckets like grow up and reports to', () => {
    expect(contentCarriesAttributeBucket('Growing up in Kyoto shaped her years.', 'birthplace')).toBe(true);
    expect(contentCarriesAttributeBucket('Ruslan reports to the Lisbon office.', 'mentorship')).toBe(true);
  });
});

describe('findRelationUnstated (B12-4 M6)', () => {
  const KENJI_LOCATION = { entity: 'kenji', attribute: 'location' } as const;
  const FATIMA_MENTORSHIP = parseQueryTopic('Who mentors Fatima?');

  it('fires on entity-matching candidates when NO same-entity candidate carries the bucket', () => {
    // Fatima's corpus rows state employment/first-person facts; nothing
    // anywhere in the top-K carries a mentorship token.
    const flags = findRelationUnstated(
      ['Fatima is a pediatric nurse at St. Marys hospital.', 'My surgical residency at Johns Hopkins keeps me busy.'],
      FATIMA_MENTORSHIP
    );
    expect(flags[0]).toBe(true); // entity fatima matches, no carrier anywhere
    expect(flags[1]).toBe(false); // first-person row parses to another subject
  });

  it('does not fire when a same-entity candidate DOES carry the bucket anywhere', () => {
    // 'uses' maps to the phone bucket, so the corpus states a phone relation.
    const flags = findRelationUnstated(
      ['Kenji uses an iPhone.', 'Someone once noted Kenji was born in Osaka.'],
      { entity: 'kenji', attribute: 'phone' }
    );
    expect(flags.every(f => f === false)).toBe(true);
  });

  it('suppresses on self-carriage: a location-stating memory blocks a location query flag', () => {
    const flags = findRelationUnstated(
      ['Kenji was born in Osaka and lived there until age twelve.'],
      KENJI_LOCATION
    );
    // 'lived' -> location: the relation IS stated, no presumed-unstated gap.
    expect(flags[0]).toBe(false);
  });

  it('never fires on unparsed queries or non-bucket attributes', () => {
    expect(findRelationUnstated(['anything'], null).every(f => f === false)).toBe(true);
    expect(findRelationUnstated(['anything'], { entity: 'x', attribute: null }).every(f => f === false)).toBe(true);
    expect(
      findRelationUnstated(['Kenji was born in Osaka.'], { entity: 'kenji', attribute: 'airline flies' }).every(
        f => f === false
      )
    ).toBe(true);
  });

  it('never fires on person-style buckets no content can carry', () => {
    const flags = findRelationUnstated(['Project Aurora ships weekly releases.'], {
      entity: 'project aurora',
      attribute: 'person',
    });
    expect(CONTENT_DETECTABLE_BUCKETS.has('person')).toBe(false);
    expect(flags[0]).toBe(false);
  });

  it('handles null/empty contents honestly', () => {
    const flags = findRelationUnstated([null, '', 'Fatima is a pediatric nurse at St. Marys hospital.'], FATIMA_MENTORSHIP);
    expect(flags).toEqual([false, false, true]);
  });
});

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

describe('parseQueryTopic', () => {
  it('parses "What <noun phrase> does X <verb>?"', () => {
    expect(parseQueryTopic('What phone does Kenji use?')).toEqual({ entity: 'kenji', attribute: 'phone' });
    expect(parseQueryTopic('What car does Dmitri want to buy?')).toEqual({ entity: 'dmitri', attribute: 'car' });
    expect(parseQueryTopic('Which instruments does Gustav play?')).toEqual({
      entity: 'gustav',
      attribute: 'instrument',
    });
  });

  it('parses the bare "What did X <verb>?" form without an interrogative noun phrase', () => {
    expect(parseQueryTopic('What did June study?')).toEqual({ entity: 'june', attribute: 'school' });
  });

  it('parses where-questions into location-family attributes', () => {
    expect(parseQueryTopic('Where does June live now?')).toEqual({ entity: 'june', attribute: 'location' });
    // A concrete noun inside the where-question overrides plain location.
    expect(parseQueryTopic('Where did Tomas go to primary school?')).toEqual({ entity: 'tomas', attribute: 'school' });
    expect(parseQueryTopic('Where does Tomas work?')).toEqual({ entity: 'tomas', attribute: 'employer' });
  });

  it('routes growing-up and birth where-questions to birthplace, not location', () => {
    expect(parseQueryTopic('Where did Kenji grow up?')).toEqual({ entity: 'kenji', attribute: 'birthplace' });
    expect(parseQueryTopic('Where was Kenji born?')).toEqual({ entity: 'kenji', attribute: 'birthplace' });
  });

  it('parses possessive forms including apostrophe-stripped corpus spellings', () => {
    expect(parseQueryTopic('What is Marisol favorite wine?')).toEqual({ entity: 'marisol', attribute: 'drink' });
    expect(parseQueryTopic('What is Ivan salary?')).toEqual({ entity: 'ivan', attribute: 'salary' });
    expect(parseQueryTopic('What is Priyas shoe size?')).toEqual({ entity: 'priya', attribute: 'shoe size' });
    expect(parseQueryTopic('What is Fatimas favorite color?')).toEqual({ entity: 'fatima', attribute: 'color' });
    expect(parseQueryTopic("What are Tomas Lindqvist's responsibilities?")).toEqual({
      entity: 'tomas lindqvist',
      attribute: 'responsibilities',
    });
  });

  it('parses "What is the <attr> of <Entity>?" inversions', () => {
    expect(parseQueryTopic('What is the salary of Ivan?')).toEqual({ entity: 'ivan', attribute: 'salary' });
  });

  it('treats single-token "What is X?" as an identity query with no comparable attribute', () => {
    expect(parseQueryTopic('What is PaperTrail?')).toEqual({ entity: 'papertrail', attribute: null });
  });

  it('parses who-questions with person as the queried attribute', () => {
    expect(parseQueryTopic('Who leads Project Aurora?')).toEqual({ entity: 'project aurora', attribute: 'person', entityRole: 'object' });
    expect(parseQueryTopic('Who is Elena Vasquez?')).toEqual({ entity: 'elena vasquez', attribute: 'person' });
  });

  it('returns honest nulls for unparseable queries instead of guessing', () => {
    expect(parseQueryTopic('Why did we pick a relational database over a document store?')).toEqual({
      entity: null,
      attribute: null,
    });
    expect(parseQueryTopic('Tell me about Helios Research Lab.')).toEqual({ entity: null, attribute: null });
    // Lowercase subjects are not reliable entities.
    expect(parseQueryTopic('What do we use for tracing across services?')).toEqual({ entity: null, attribute: null });
    expect(parseQueryTopic('')).toEqual({ entity: null, attribute: null });
  });
});

// ---------------------------------------------------------------------------
// Memory parsing
// ---------------------------------------------------------------------------

describe('parseMemoryTopic', () => {
  it('extracts birthplace facts', () => {
    expect(parseMemoryTopic('Kenji was born in Tokyo.')).toEqual({ entity: 'kenji', attribute: 'birthplace' });
  });

  it('maps the use-verb to the phone/device bucket', () => {
    expect(parseMemoryTopic('Kenji uses an iPhone.')).toEqual({ entity: 'kenji', attribute: 'phone' });
  });

  it('extracts current-residence facts as location', () => {
    expect(parseMemoryTopic('Ivan lives in a two-bedroom apartment in Riga.')).toEqual({
      entity: 'ivan',
      attribute: 'location',
    });
  });

  it('extracts employer facts', () => {
    expect(parseMemoryTopic('Tomas has worked at the fisheries institute since 2015.')).toEqual({
      entity: 'tomas',
      attribute: 'employer',
    });
  });

  it('reads first-person childhood sentences around the place, not the gerund', () => {
    expect(parseMemoryTopic('Growing up in Kyoto shaped my early years.')).toEqual({
      entity: 'kyoto',
      attribute: 'birthplace',
    });
  });

  it('finds mid-sentence proper nouns when the sentence opens with first-person framing', () => {
    expect(parseMemoryTopic('My surgical residency at Johns Hopkins keeps me busy.')).toEqual({
      entity: 'johns hopkins',
      attribute: 'employer',
      firstPerson: true,
    });
  });

  it('only reads the first sentence so trailing clauses cannot hijack the subject', () => {
    const t = parseMemoryTopic(
      'Project Aurora is our retrieval harness; Priya Nair leads it and the goal is reproducible benchmarks.'
    );
    expect(t.entity).toBe('project aurora');
  });

  it('returns nulls for empty or entity-free content', () => {
    expect(parseMemoryTopic('')).toEqual({ entity: null, attribute: null });
    expect(parseMemoryTopic('It was raining all afternoon.')).toEqual({ entity: null, attribute: null });
  });
});

// ---------------------------------------------------------------------------
// First-person attribution (Batch B12-2b Fix A)
// ---------------------------------------------------------------------------

describe('parseMemoryTopic first-person attribution', () => {
  it('marks my/our/i/we sentence openers as firstPerson, case-insensitive', () => {
    expect(parseMemoryTopic('My favorite snack is a peanut butter sandwich.').firstPerson).toBe(true);
    expect(parseMemoryTopic('WE cache computed embeddings inside Redis.').firstPerson).toBe(true);
    expect(parseMemoryTopic("i'm not sure about that").firstPerson).toBeUndefined(); // marker needs trailing space
    expect(parseMemoryTopic('Our team ships weekly.').firstPerson).toBe(true);
    expect(parseMemoryTopic('we agreed on the design').firstPerson).toBe(true);
    expect(parseMemoryTopic('Kenji was born in Tokyo.').firstPerson).toBeUndefined();
    expect(parseMemoryTopic('The atlas project uses PostgreSQL.').firstPerson).toBeUndefined();
  });

  it('does not trigger on words merely starting with the markers', () => {
    expect(parseMemoryTopic('Item two was shipped late.').firstPerson).toBeUndefined();
    expect(parseMemoryTopic('Mysql migration finished.').firstPerson).toBeUndefined();
  });

  it('keeps the field off non-first-person topics so structural comparisons stay stable', () => {
    const t = parseMemoryTopic('Kenji uses an iPhone.');
    expect(t).toEqual({ entity: 'kenji', attribute: 'phone' });
  });
});

describe('topicalAlignment first-person rule', () => {
  // The bench's ua_6/ua_8/ua_13 winner: a first-person falsehood with no
  // parseable subject of its own.
  const snack = parseMemoryTopic('My favorite snack is a peanut butter sandwich.');

  it('judges a first-person memory cannot-answer for a parsed third-party query entity', () => {
    // Without the rule this pair was alignment=null (memory entity unparseable)
    // and the planted falsehood sailed through at HIGH confidence.
    expect(topicalAlignment({ entity: 'fatima', attribute: 'color' }, snack)).toBe(0);
    expect(topicalAlignment({ entity: 'hana', attribute: 'movie' }, snack)).toBe(0);
    expect(topicalAlignment({ entity: 'mireia', attribute: 'book' }, snack)).toBe(0);
  });

  it('stays neutral when the query has no entity (agent self-queries)', () => {
    expect(topicalAlignment({ entity: null, attribute: 'movie' }, snack)).toBeNull();
    expect(topicalAlignment({ entity: null, attribute: null }, snack)).toBeNull();
  });

  it('applies even when the memory otherwise parsed fully', () => {
    const residency = parseMemoryTopic('My surgical residency at Johns Hopkins keeps me busy.');
    expect(residency.entity).toBe('johns hopkins'); // parses, yet...
    expect(topicalAlignment({ entity: 'fatima', attribute: 'employer' }, residency)).toBe(0);
  });

  it('leaves third-person memories governed by the plain truth table', () => {
    const born = parseMemoryTopic('Kenji was born in Tokyo.');
    expect(topicalAlignment({ entity: 'fatima', attribute: 'color' }, born)).toBe(0); // entity mismatch
    expect(topicalAlignment({ entity: 'kenji', attribute: 'birthplace' }, born)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pace vs sport buckets (Batch B12-2b Fix B)
// ---------------------------------------------------------------------------

describe('pace metric bucket is distinct from sport event bucket', () => {
  it('parses query-side pace nouns into the pace bucket', () => {
    expect(TOPIC_ATTRIBUTE_BUCKETS).toContain('pace');
    expect(parseQueryTopic('What pace does Pablo run?')).toEqual({ entity: 'pablo', attribute: 'pace' });
    expect(parseQueryTopic('What speed does Kaya jog at?').attribute).toBe('pace');
    expect(parseQueryTopic('What is Priyas split?').attribute).toBe('pace');
    expect(parseQueryTopic('What is Aikos personal best?').attribute).toBe('pace');
    expect(parseQueryTopic('What is Sven pb for the mile?').attribute).toBe('pace');
  });

  it('parses memory-side event/training vocabulary into the sport bucket', () => {
    expect(parseMemoryTopic('Pablo is training for his first marathon in Valencia.')).toEqual({
      entity: 'pablo',
      attribute: 'sport',
    });
    expect(parseMemoryTopic('Dmitri loves cycling on weekends.').attribute).toBe('sport');
    expect(parseMemoryTopic('Kaya hits the gym before dawn.').attribute).toBe('sport');
    expect(parseMemoryTopic('Sven does his workout at noon.').attribute).toBe('sport');
  });

  it('CRITICAL: a pace query against an event-description memory is judged mismatch (0), not neutral', () => {
    const q = parseQueryTopic('What pace does Pablo run?');
    const m = parseMemoryTopic('Pablo is training for his first marathon in Valencia.');
    expect(topicalAlignment(q, m)).toBe(0);
    // Direct truth-table form too.
    expect(topicalAlignment({ entity: 'pablo', attribute: 'pace' }, { entity: 'pablo', attribute: 'sport' })).toBe(0);
  });

  it('keeps the legit same-bucket sport case at full credit (1)', () => {
    const q = parseQueryTopic('What sport does Aiko play competitively?');
    const m = parseMemoryTopic('Aiko plays competitive badminton on weekends.');
    expect(q.attribute).toBe('sport');
    expect(m.attribute).toBe('sport');
    expect(topicalAlignment(q, m)).toBe(1);
  });

  it('still rewards a genuine metric answer about the same person', () => {
    const q = parseQueryTopic('What pace does Pablo run?');
    const m = parseMemoryTopic('Pablo holds a steady pace of five minutes per kilometer.');
    expect(topicalAlignment(q, m)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bucket normalization
// ---------------------------------------------------------------------------

describe('attribute bucket normalization', () => {
  it('normalizes synonyms onto canonical buckets', () => {
    expect(TOPIC_ATTRIBUTE_BUCKETS).toContain('phone');
    expect(TOPIC_ATTRIBUTE_BUCKETS).toContain('location');
    expect(TOPIC_ATTRIBUTE_BUCKETS).toContain('birthplace');
    // device -> phone bucket via query normalization
    expect(parseQueryTopic('What device does Kenji use?').attribute).toBe('phone');
    // resides -> location bucket on the memory side
    expect(parseMemoryTopic('Ivan resides in Riga with his family.').attribute).toBe('location');
  });

  it('keeps born (birthplace) distinct from lives-now (location)', () => {
    const locationQuery: QueryTopic = { entity: 'june', attribute: 'location' };
    const birthMemory: QueryTopic = { entity: 'june', attribute: 'birthplace' };
    // Born-vs-lives-now are different facts about the same person.
    expect(topicalAlignment(locationQuery, birthMemory)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Alignment truth table
// ---------------------------------------------------------------------------

describe('topicalAlignment truth table', () => {
  it('entity match + attribute match -> 1', () => {
    expect(topicalAlignment(
      { entity: 'kenji', attribute: 'phone' },
      { entity: 'kenji', attribute: 'phone' }
    )).toBe(1);
  });

  it('entity match + attribute mismatch -> 0 (the target case)', () => {
    expect(topicalAlignment(
      { entity: 'kenji', attribute: 'phone' },
      { entity: 'kenji', attribute: 'birthplace' }
    )).toBe(0);
  });

  it('entity mismatch -> 0 regardless of attributes', () => {
    expect(topicalAlignment(
      { entity: 'hana', attribute: 'movie' },
      { entity: 'kyoto', attribute: 'movie' }
    )).toBe(0);
  });

  it('any null on either side -> null (never penalize what cannot be parsed)', () => {
    expect(topicalAlignment(
      { entity: null, attribute: 'phone' },
      { entity: 'kenji', attribute: 'phone' }
    )).toBeNull();
    expect(topicalAlignment(
      { entity: 'kenji', attribute: null },
      { entity: 'kenji', attribute: 'phone' }
    )).toBeNull();
    expect(topicalAlignment(
      { entity: 'kenji', attribute: 'phone' },
      { entity: null, attribute: null }
    )).toBeNull();
  });

  it('attribute containment -> 0.7 partial credit', () => {
    expect(topicalAlignment(
      { entity: 'maria', attribute: 'favorite color' },
      { entity: 'maria', attribute: 'color' }
    )).toBe(0.7);
  });

  it('entity matching is case-insensitive containment-based', () => {
    expect(topicsAboutSameEntity('Elena Vasquez', 'dr elena vasquez')).toBe(true);
    expect(topicsAboutSameEntity('kenji', 'kimura')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeRecallConfidence integration (B1 factors + B2 coverage)
// ---------------------------------------------------------------------------

describe('computeRecallConfidence with topical alignment', () => {
  /** Strong convergent evidence: high semantics + lexical top-3 agreement. */
  function strongEvidence(alignment: number | null): RecallEvidence {
    return makeEvidence({
      semantic: 0.95,
      lexical: { rank: 1, score: 0.95 },
      freshness: 1,
      memoryConfidence: 'certain',
      topicalAlignment: alignment,
    });
  }

  it('alignment 0 drives strong evidence below ~0.45 even with full agreement bonuses', () => {
    const { confidence } = computeRecallConfidence(strongEvidence(0), HEALTHY_CTX);
    expect(confidence).toBeLessThanOrEqual(0.45);
  });

  it('alignment null leaves identical evidence above 0.9 (neutrality contract)', () => {
    const { confidence } = computeRecallConfidence(strongEvidence(null), HEALTHY_CTX);
    expect(confidence).toBeGreaterThan(0.9);
  });

  it('alignment 1 is exactly neutral versus baseline (no alignment field set)', () => {
    const baseline = computeRecallConfidence(strongEvidence(null), HEALTHY_CTX);
    const aligned = computeRecallConfidence(strongEvidence(1), HEALTHY_CTX);
    expect(aligned.confidence).toBe(baseline.confidence);
    expect(aligned.tier).toBe(baseline.tier);
  });

  it('partial overlap (0.7) discounts mildly relative to baseline', () => {
    // Mid-range semantics keep the baseline strictly below the clamp so the
    // exact multiplicative relation is observable.
    const mid = makeEvidence({ semantic: 0.85, freshness: 1, memoryConfidence: 'certain', topicalAlignment: null });
    const partial = makeEvidence({ semantic: 0.85, freshness: 1, memoryConfidence: 'certain', topicalAlignment: 0.7 });
    const baseline = computeRecallConfidence(mid, MARGIN_NEUTRAL_CTX);
    const discounted = computeRecallConfidence(partial, MARGIN_NEUTRAL_CTX);
    expect(baseline.confidence).toBeLessThan(1);
    expect(discounted.confidence).toBeCloseTo(baseline.confidence * C.TOPICAL_PARTIAL_FACTOR, 5);
  });

  it('applies the mismatch AFTER agreement so bonuses cannot resurrect trust', () => {
    // Max out every additive bonus: lexical top-3 + graph boost.
    const maxed = makeEvidence({
      semantic: 0.99,
      lexical: { rank: 1, score: 1 },
      graph: 0.05,
      freshness: 1,
      memoryConfidence: 'certain',
      topicalAlignment: 0,
    });
    const { confidence } = computeRecallConfidence(maxed, MARGIN_NEUTRAL_CTX);
    // base(0.99) + capped bonuses saturates at 1.0 pre-factor; with a neutral
    // margin factor the mismatch multiply alone bounds final trust.
    expect(confidence).toBeCloseTo(C.TOPICAL_MISMATCH_FACTOR, 5);
    expect(confidence).toBeLessThan(C.TIER_QUALIFIED_MIN);
  });

  it('topic-absent coverage multiplies an extra factor when ALL candidate alignments are 0', () => {
    const alone = computeRecallConfidence(strongEvidence(0), HEALTHY_CTX);
    const covered = computeRecallConfidence(strongEvidence(0), { ...HEALTHY_CTX, candidateAlignments: [0] });
    const mixed = computeRecallConfidence(strongEvidence(0), { ...HEALTHY_CTX, candidateAlignments: [0, 1] });
    const allNull = computeRecallConfidence(strongEvidence(0), { ...HEALTHY_CTX, candidateAlignments: [null, null] });

    expect(covered.confidence).toBeCloseTo(alone.confidence * C.COVERAGE_TOPIC_ABSENT_FACTOR, 5);
    // A single aligned-1 sibling proves the corpus CAN address the attribute.
    expect(mixed.confidence).toBe(alone.confidence);
    // Nothing computable anywhere -> neutral (no fabricated coverage signal).
    expect(allNull.confidence).toBe(alone.confidence);
  });

  it('assessRecall flips a mismatch-penalized best result to no_reliable_memory', () => {
    const penalized = computeRecallConfidence(strongEvidence(0), HEALTHY_CTX).confidence;
    expect(penalized).toBeLessThan(DEFAULT_ABSTAIN_BELOW);
    const assessment = assessRecall([{ recallConfidence: penalized }]);
    expect(assessment.verdict).toBe('no_reliable_memory');

    // Identical evidence without the parsed mismatch stays reportable.
    const neutral = computeRecallConfidence(strongEvidence(null), HEALTHY_CTX).confidence;
    expect(neutral).toBeGreaterThan(DEFAULT_ABSTAIN_BELOW);
    expect(assessRecall([{ recallConfidence: neutral }]).verdict).not.toBe('no_reliable_memory');
  });
});

// ---------------------------------------------------------------------------
// Honest evidence assembly
// ---------------------------------------------------------------------------

describe('buildEvidence topical alignment plumbing', () => {
  const nowMs = Date.UTC(2026, 7, 25);

  it('stays null when no query topic was provided (signal unavailable, never fabricated)', () => {
    const result: any = { id: 'm1', content: 'Kenji was born in Tokyo.', scoreBreakdown: {} };
    const ev = buildEvidence(
      result,
      undefined,
      { contradictingCount: 0, supportingCount: 0, supersededBy: null },
      { candidateSemanticScores: [], multiSignalQuery: false },
      nowMs
    );
    expect(ev.topicalAlignment).toBeNull();
  });

  it('computes the alignment when the caller passes a parsed query topic', () => {
    const result: any = { id: 'm1', content: 'Kenji was born in Tokyo.', scoreBreakdown: {} };
    const ctx = {
      candidateSemanticScores: [] as Array<number | null>,
      multiSignalQuery: false,
      queryTopic: parseQueryTopic('What phone does Kenji use?'),
    };
    const ev = buildEvidence(
      result,
      undefined,
      { contradictingCount: 0, supportingCount: 0, supersededBy: null },
      ctx,
      nowMs
    );
    expect(ev.topicalAlignment).toBe(0); // same person, wrong fact

    const onTopic = buildEvidence(
      { id: 'm2', content: 'Kenji uses an iPhone.', scoreBreakdown: {} } as any,
      undefined,
      { contradictingCount: 0, supportingCount: 0, supersededBy: null },
      ctx,
      nowMs
    );
    expect(onTopic.topicalAlignment).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: temp-dir DB isolation through the real search pipeline
// ---------------------------------------------------------------------------

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let savedBundledModel: string | undefined;
let savedProvider: string | undefined;
let hybridSearch: typeof import('../../../core/memory/hybrid-search.js').hybridSearch;
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

interface SearchOutcome {
  results: Array<{ id: string; content?: string; recallConfidence?: number } & Record<string, any>>;
  verdict: string | null;
}

async function searchWithAssessment(query: string): Promise<SearchOutcome> {
  const results = await hybridSearch({ query, trace: true }, { limit: 5 });
  const trace = (results[0] as any)?._trace;
  return {
    results: results as any,
    verdict: trace?.recallAssessment?.verdict ?? null,
  };
}

describe('topical alignment end-to-end (unanswerable abstention)', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    savedBundledModel = process.env.SQUISH_LOCAL_BUNDLED_MODEL;
    savedProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;

    testDataDir = join(tmpdir(), `squish-topical-alignment-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const hsMod = await import('../../../core/memory/hybrid-search.js');
    const memMod = await import('../../../core/memory/memories.js');
    const dbMod = await import('../../../db/index.js');
    hybridSearch = hsMod.hybridSearch;
    rememberMemory = memMod.rememberMemory;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;
    resetDb();
  });

  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedBundledModel === undefined) delete process.env.SQUISH_LOCAL_BUNDLED_MODEL;
    else process.env.SQUISH_LOCAL_BUNDLED_MODEL = savedBundledModel;
    if (savedProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
    else process.env.SQUISH_EMBEDDINGS_PROVIDER = savedProvider;
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(async () => {
    resetDb();
    const db = await getDb();
    const sqlite = (db as any).$client;
    if (sqlite && typeof sqlite.exec === 'function') {
      sqlite.exec('DELETE FROM memories;');
    }
  });

  it('abstains when only a wrong-attribute memory for the entity exists', async () => {
    await rememberMemory({ content: 'Kenji was born in Tokyo.', type: 'fact', user: 'test-user' });
    await rememberMemory({ content: 'The quarterly report deadline moved to Friday.', type: 'fact', user: 'test-user' });
    await rememberMemory({ content: 'The office kitchen was restocked with coffee pods.', type: 'observation', user: 'test-user' });

    const { results, verdict } = await searchWithAssessment('What phone does Kenji use?');

    // The birth record may still RANK first - ranking is untouched by design -
    // but its calibrated trust must collapse below the abstain floor.
    const born = results.find(r => (r.content ?? '').includes('born'));
    expect(born).toBeDefined();
    expect(born!.evidence?.topicalAlignment).toBe(0); // same person, wrong fact
    expect(born!.recallConfidence ?? 1).toBeLessThan(0.35);
    expect(born!.confidenceTier).toBe('LOW');

    // Overall best stays under the confident-wrong band; unrelated fillers
    // keep their honest mid-low trust but nothing may claim confidence.
    const bestConfidence = Math.max(0, ...results.map(r => r.recallConfidence ?? 0));
    expect(bestConfidence).toBeLessThan(0.5);
    expect(verdict).not.toBe('confident');
  });

  it('answers confidently once the actual phone fact is seeded', async () => {
    await rememberMemory({ content: 'Kenji was born in Tokyo.', type: 'fact', user: 'test-user' });
    await rememberMemory({ content: 'Kenji uses an iPhone.', type: 'fact', user: 'test-user' });
    await rememberMemory({ content: 'The quarterly report deadline moved to Friday.', type: 'fact', user: 'test-user' });
    await rememberMemory({ content: 'The office kitchen was restocked with coffee pods.', type: 'observation', user: 'test-user' });

    const { results, verdict } = await searchWithAssessment('What phone does Kenji use?');

    // The iPhone memory must be present AND trusted more than the birth record.
    const iphone = results.find(r => (r.content ?? '').includes('iPhone'));
    expect(iphone).toBeDefined();
    const born = results.find(r => (r.content ?? '').includes('born'));
    expect(born).toBeDefined();
    expect((iphone!.recallConfidence ?? 0)).toBeGreaterThan((born?.recallConfidence ?? 0));

    const bestConfidence = Math.max(0, ...results.map(r => r.recallConfidence ?? 0));
    expect(bestConfidence).toBeGreaterThanOrEqual(0.6);
    expect(['confident', 'qualified']).toContain(verdict);
  });

  it('a first-person memory cannot confidently answer a third-party query (B12-2b Fix A)', async () => {
    // The exact ua_8 mechanism: Hana's first-person snack note used to win
    // "What is Hanas favorite movie?" at HIGH confidence because its subject
    // was unparseable and alignment stayed neutral.
    await rememberMemory({ content: 'My favorite snack is a peanut butter sandwich.', type: 'observation', user: 'test-user' });
    await rememberMemory({ content: 'The office kitchen was restocked with coffee pods.', type: 'observation', user: 'test-user' });

    const { results, verdict } = await searchWithAssessment('What is Hanas favorite movie?');

    const snack = results.find(r => (r.content ?? '').includes('peanut butter'));
    if (snack) {
      expect(snack.evidence?.topicalAlignment).toBe(0); // judged cannot-answer
      expect(snack.recallConfidence ?? 1).toBeLessThan(0.35);
    }
    const bestConfidence = Math.max(0, ...results.map(r => r.recallConfidence ?? 0));
    expect(bestConfidence).toBeLessThan(0.6);
    expect(verdict).toBe('no_reliable_memory');
  });

  it('a metric query is not answered by an event description (B12-2b Fix B)', async () => {
    // The ua_16 mechanism: "What pace does Pablo run?" vs Pablo's real
    // marathon-training fact - entities matched but neither side mapped to a
    // bucket, so confidence ran away. Now both sides parse and mismatch.
    await rememberMemory({ content: 'Pablo is training for his first marathon in Valencia.', type: 'fact', user: 'test-user' });
    await rememberMemory({ content: 'The office kitchen was restocked with coffee pods.', type: 'observation', user: 'test-user' });

    const { results, verdict } = await searchWithAssessment('What pace does Pablo run?');

    const marathon = results.find(r => (r.content ?? '').includes('marathon'));
    if (marathon) {
      expect(marathon.evidence?.topicalAlignment).toBe(0); // pace asked, sport described
      expect(marathon.recallConfidence ?? 1).toBeLessThan(0.5);
    }
    const bestConfidence = Math.max(0, ...results.map(r => r.recallConfidence ?? 0));
    expect(verdict).toBe('no_reliable_memory');
  });

  it('a presumed-relation question is not answered by an unrelated same-entity fact (B12-4 M6)', async () => {
    // The wrong-relationship_2 mechanism: "Who mentors Fatima?" vs Fatima's
    // employer-shaped fact. Alignment cannot fire (memory attribute
    // unparseable), so the entity-scoped relation-unstated discount must.
    await rememberMemory({ content: 'Fatima is a pediatric nurse at St. Marys hospital.', type: 'fact', user: 'test-user' });
    await rememberMemory({ content: 'The office kitchen was restocked with coffee pods.', type: 'observation', user: 'test-user' });

    const { results, verdict } = await searchWithAssessment('Who mentors Fatima?');

    const nurse = results.find(r => (r.content ?? '').includes('pediatric'));
    if (nurse) {
      expect(nurse.evidence?.topicalAlignment).toBeNull(); // memory-side attr unparseable -> neutral
      expect(nurse.recallConfidence ?? 1).toBeLessThan(0.5); // RELATION_UNSTATED_FACTOR applied
      expect(nurse.confidenceTier).toBe('LOW');
    }
    const bestConfidence = Math.max(0, ...results.map(r => r.recallConfidence ?? 0));
    expect(verdict).toBe('no_reliable_memory');
  });

  it('a multi-hop purchase question is not answered by a birth record (B12-4)', async () => {
    // The multi-hop-trap_1 shape: "In which city did Kenji buy his phone?"
    // used to sail through unparsed; family F now parses {kenji, location}
    // and the birthplace record mismatches.
    await rememberMemory({ content: 'Kenji was born in Osaka and lived there until age twelve.', type: 'fact', user: 'test-user' });
    await rememberMemory({ content: 'The office kitchen was restocked with coffee pods.', type: 'observation', user: 'test-user' });

    const { results, verdict } = await searchWithAssessment('In which city did Kenji buy his phone?');

    const born = results.find(r => (r.content ?? '').includes('born'));
    if (born) {
      expect(born.evidence?.topicalAlignment).toBe(0); // location asked, birthplace stated
      expect(born.recallConfidence ?? 1).toBeLessThan(0.4);
    }
    const bestConfidence = Math.max(0, ...results.map(r => r.recallConfidence ?? 0));
    expect(verdict).toBe('no_reliable_memory');
  });
});

// ---------------------------------------------------------------------------
// WS2b: generalizable retrieval-quality fixes (TDD - written before the fix)
// ---------------------------------------------------------------------------

describe('WS2b family-A starvation fix: "What does <Entity> do ..." parses via fall-through', () => {
  // The lazy np of family A can consume the FIRST auxiliary in "What does X
  // do ...?" and then hard-return a null when the leftover tail has no
  // capitalized run - starving family A2, which exists exactly for the bare
  // form. The fix makes family A fall through when no entity parses, so ANY
  // "What does <Name> ..." shape (a huge question family) reaches attribution
  // guards. Tested on multiple inputs, none of them an eval query verbatim.
  it('parses multiple unseen "What does X do/verb ..." shapes', () => {
    expect(parseQueryTopic('What does Mireia do on weekends?').entity).toBe('mireia');
    expect(parseQueryTopic('What does Farid do for a living?').entity).toBe('farid');
    expect(parseQueryTopic('What does Hana do after work?').entity).toBe('hana');
    expect(parseQueryTopic('What does Tomas do at the institute?').entity).toBe('tomas');
  });

  it('keeps honest nulls when fall-through finds no capitalized entity either', () => {
    // Lowercase subjects and pronoun subjects must NOT acquire fabricated
    // entities from the fall-through.
    expect(parseQueryTopic('What does the atlas project do?')).toEqual({ entity: null, attribute: null });
    expect(parseQueryTopic('What does it do on weekends?')).toEqual({ entity: null, attribute: null });
  });

  it('derives the bucket from the verb tail after fall-through', () => {
    const q = parseQueryTopic('What does Dario do for work?');
    expect(q.entity).toBe('dario');
    expect(q.attribute).toBe('employer');
  });

  it('a first-person memory is JUDGED cannot-answer for a fall-through-parsed query', () => {
    // The whole point of the repair: without the entity there, the B12-2b
    // first-person rule stays neutral and the falsehood sails through.
    const q = parseQueryTopic('What does Mireia do on weekends?');
    expect(topicalAlignment(q, parseMemoryTopic('My weekend golf club membership is my main hobby.'))).toBe(0);
  });
});

describe('WS2b entity-mismatch precedence: a different parsed subject cannot answer', () => {
  // Documented contract (module header truth table): "alignment 0.0 -> entity
  // mismatch OR same entity with a different attribute bucket". The old code
  // gated the entity comparison behind BOTH attributes parsing, so a lexicon
  // miss on either side re-opened the door to wrong-subject hijacks. When
  // both sides parse an entity and they differ, that is positive evidence -
  // attributes add nothing. Generalized across entity/attribute combinations.
  it('returns 0 for parsed-different entities even when memory attribute is null', () => {
    expect(topicalAlignment(
      { entity: 'pablo', attribute: 'pace' },
      { entity: 'dario', attribute: null }
    )).toBe(0);
    expect(topicalAlignment(
      { entity: 'renata', attribute: 'yoga style' },
      { entity: 'olga', attribute: null }
    )).toBe(0);
    expect(topicalAlignment(
      { entity: 'thandiwe', attribute: 'location' },
      { entity: 'cleo', attribute: null }
    )).toBe(0);
  });

  it('identity-shaped queries (no asked attribute) stay neutral', () => {
    // "What is X?" has no attribute to mismatch against; a memory about
    // another subject may still define X through a relation. The verdict
    // needs an ASK, not just an entity.
    expect(topicalAlignment(
      { entity: 'thandiwe', attribute: null },
      { entity: 'cleo', attribute: 'location' }
    )).toBeNull();
  });

  it('a content mention of the query entity softens the verdict to partial (0.7)', () => {
    // Related coverage, not a stated answer: "Project Borealis is built
    // with Nordwind Energy" MENTIONS the queried entity but is ABOUT Borealis.
    const q = { entity: 'nordwind energy', attribute: 'do for us' };
    const m = { entity: 'project borealis', attribute: null };
    expect(topicalAlignment(q, m)).toBe(0); // topic-only: wrong subject
    expect(topicalAlignment(q, m, 'Project Borealis is the forecasting benchmark built with Nordwind Energy.')).toBe(0.7);
    // No mention -> hard mismatch stands even with content passed.
    expect(topicalAlignment(q, m, 'Project Borealis was built with wind-farm telemetry.')).toBe(0);
    // Word-boundary semantics: 'qdrant' must not "mention" inside 'qdrants'...
    expect(topicalAlignment(
      { entity: 'aura', attribute: 'stack' },
      { entity: 'other', attribute: null },
      'Aura Systems ships weekly.'
    )).toBe(0.7);
    expect(topicalAlignment(
      { entity: 'aurora', attribute: 'stack' },
      { entity: 'other', attribute: null },
      'The aurelian dynasty'
    )).toBe(0);
  });

  it('keeps SAME-entity missing-attribute pairs null (neutral-by-contract untouched)', () => {
    expect(topicalAlignment(
      { entity: 'kenji', attribute: 'phone' },
      { entity: 'kenji', attribute: null }
    )).toBeNull();
    expect(topicalAlignment(
      { entity: 'kenji', attribute: null },
      { entity: 'kenji', attribute: 'phone' }
    )).toBeNull();
  });

  it('keeps missing-entity pairs null (cannot parse = never penalize)', () => {
    expect(topicalAlignment(
      { entity: null, attribute: 'phone' },
      { entity: 'cleo', attribute: null }
    )).toBeNull();
    expect(topicalAlignment(
      { entity: 'thandiwe', attribute: 'location' },
      { entity: null, attribute: null }
    )).toBeNull();
  });

  it('keeps entity comparison case-insensitive across the precedence path', () => {
    expect(topicalAlignment(
      { entity: 'thandiwe', attribute: 'location' },
      { entity: 'Thandiwe Kanku', attribute: null }
    )).toBeNull(); // same person (containment), attribute missing -> neutral
    expect(topicalAlignment(
      { entity: 'Thandiwe', attribute: 'location' },
      { entity: 'cleo', attribute: null }
    )).toBe(0);
  });

  it('keeps object-role queries (Who <verb> Entity? / Which thing relates Entity?) on the old attribute-gated semantics', () => {
    // "Who leads Project Aurora?" - the ANSWER is a different entity than the
    // parsed object, so subject-mismatch is NOT evidence of cannot-answer.
    const q = parseQueryTopic('Who leads Project Aurora?');
    expect(q.entityRole).toBe('object');
    expect(topicalAlignment(q, { entity: 'priya', attribute: null })).toBeNull();
    // With both attributes parsed, the pre-existing behavior stands (0).
    expect(topicalAlignment(q, { entity: 'priya', attribute: 'mentorship' })).toBe(0);
    // Family G ("Which project depends on PaperTrail...") has the same
    // object-slot structure: the parsed entity is the relation's object.
    const g = parseQueryTopic('Which project depends on PaperTrail and why?');
    expect(g.entity).toBe('papertrail');
    expect(g.entityRole).toBe('object');
    expect(topicalAlignment(g, { entity: 'project aurora', attribute: null })).toBeNull();
  });

  it('keeps the first-person rule above entity parsing', () => {
    const snack = parseMemoryTopic('My favorite snack is a peanut butter sandwich.');
    expect(topicalAlignment({ entity: 'nobody matters', attribute: null }, snack)).toBe(0);
  });
});

describe('WS2b attribute lexicon broadening (unseen synonyms, general classes)', () => {
  // Autopsy Mechanism B: attribute vocabulary gaps let same-entity wrong
  // facts sail through on neutral nulls. The delivered fix adds UNAMBIGUOUS
  // synonym entries (app/device-software, profession/occupation, brand as a
  // product attribute) and documents one DELIBERATE non-addition (run) where
  // polysemy would fabricate mismatches against correct answers. None of the
  // inputs below are eval-set sentences.
  it('does NOT map the polysemous "run" verb to sport (deliberate lexicon boundary)', () => {
    // Autopsy Mechanism B named 'run' as a gap, but in engineering corpora
    // run is overwhelmingly "execute" ("Vessel runs Podman containers",
    // "the vector store runs FAISS", "Harbor runs its CI"). Mapping it to
    // sport would fabricate wrong mismatches against legitimate answers -
    // the neutral null is the honest outcome. Regression guard: these
    // memory-side parses must stay attribute-null (neutral), not sport.
    expect(parseMemoryTopic('Vessel now runs Podman containers.').attribute).toBeNull();
    expect(parseMemoryTopic('Harbor runs its CI on Jenkins.').attribute).toBeNull();
    // Already-mapped exercise synonyms keep working (jog/swim/marathon):
    expect(parseMemoryTopic('Kaya jogs at sunrise.').attribute).toBe('sport');
    expect(parseMemoryTopic('Pablo is training for a marathon.').attribute).toBe('sport');
  });

  it('adds the software/app relation to the phone/device bucket (query AND memory side)', () => {
    expect(parseQueryTopic('Which app does Greta track meals in?').attribute).toBe('phone');
    expect(parseMemoryTopic('Greta uses a meal journal app.').attribute).toBe('phone');
    // Same-entity on-topic stays full credit - adding the synonym must not
    // fabricate a mismatch against a genuine answer.
    const q = parseQueryTopic('Which app does Greta use?');
    expect(topicalAlignment(q, parseMemoryTopic('Greta uses a meal journal app.'))).toBe(1);
  });

  it('resolves occupation synonyms to employer', () => {
    expect(parseQueryTopic('What is Fatimas profession?').attribute).toBe('employer');
    expect(parseQueryTopic('What is Svens occupation?').attribute).toBe('employer');
  });

  it('promotes brand to a first-class product attribute bucket', () => {
    expect(TOPIC_ATTRIBUTE_BUCKETS).toContain('brand');
    expect(CONTENT_DETECTABLE_BUCKETS.has('brand')).toBe(true);
    expect(parseQueryTopic('What brand of soap does Greta buy?').attribute).toBe('brand');
    expect(contentCarriesAttributeBucket('Greta prefers an Italian olive oil brand.', 'brand')).toBe(true);
    expect(contentCarriesAttributeBucket('Greta buys olive oil at the market.', 'brand')).toBe(false);
  });

  it('fires findRelationUnstated for an entity-scoped brand query the corpus never answers', () => {
    // The generalization of the near-miss mechanism: asked-for relation,
    // same entity, and NO same-entity memory states the relation anywhere.
    const q = parseQueryTopic('Which notebook brand does Leon write in?');
    expect(q.attribute).toBe('brand');
    const flags = findRelationUnstated(['Leon writes notes on paper during interviews.'], q);
    expect(flags[0]).toBe(true);
    // If a same-entity memory DOES state the relation, the flag must not fire.
    const answered = findRelationUnstated(['Leon swears by the Moleskine brand of notebooks.'], q);
    expect(answered[0]).toBe(false);
  });

  it('fires findRelationUnstated for the app relation when the entity never mentions one', () => {
    const q = parseQueryTopic('Which meditation app does Olive subscribe to?');
    expect(q.attribute).toBe('phone');
    const flags = findRelationUnstated(['Olive meditates for ten minutes before standup meetings.'], q);
    expect(flags[0]).toBe(true);
  });
});

describe('WS2b computeRecallConfidence through the precedence path', () => {
  function strongEvidenceW(topicAlign: number): RecallEvidence {
    return makeEvidence({
      semantic: 0.95,
      lexical: { rank: 1, score: 0.95 },
      freshness: 1,
      memoryConfidence: 'certain',
      topicalAlignment: topicAlign,
    });
  }

  it('collapses subject-only mismatch trust below the abstain floor', () => {
    const q = parseQueryTopic('Where does Thandiwe keep her passport?');
    const m = parseMemoryTopic('Cleo keeps the spare keys in the hallway cabinet.');
    expect(q.entity).toBe('thandiwe');
    expect(m.entity).toBe('cleo');
    expect(topicalAlignment(q, m)).toBe(0);
    const { confidence } = computeRecallConfidence(strongEvidenceW(0), HEALTHY_CTX);
    expect(confidence).toBeLessThan(DEFAULT_ABSTAIN_BELOW);
  });
});

describe('WS2b relation parsing without a proper-noun subject', () => {
  it('retains the asked relation for common-noun subjects and time-framed questions', () => {
    expect(parseQueryTopic('What brand of coffee pods does the office stock?')).toEqual({ entity: null, attribute: 'brand' });
    expect(parseQueryTopic('When does the fire extinguisher inspection expire?')).toEqual({ entity: null, attribute: 'expiration' });
  });

  it('parses an unlisted what-attribute-is template and possessive subject', () => {
    expect(parseQueryTopic('What breed is Hanas sisters dog?')).toEqual({ entity: 'hana', attribute: 'breed' });
  });

  it('keeps the existing bare What-does family reachable after a false family-A match', () => {
    expect(parseQueryTopic('What does Mireia do on weekends?').entity).toBe('mireia');
  });
});

describe('WS2b unscoped relation absence', () => {
  it('reduces trust when an unscoped query relation is absent from all returned evidence', () => {
    const query = parseQueryTopic('What brand of coffee pods does the office stock?');
    expect(findRelationUnstated([
      'The office kitchen was restocked with new coffee pods on Tuesday.',
      'Ines bikes to the office outside of winter.',
    ], query)).toEqual([true, true]);
  });

  it('does not mark a relation absent when any returned evidence states it', () => {
    const query = parseQueryTopic('What brand of coffee pods does the office stock?');
    expect(findRelationUnstated([
      'The office kitchen was restocked with new coffee pods on Tuesday.',
      'The office stocks Northstar brand coffee pods.',
    ], query)).toEqual([false, false]);
  });

  it('scopes parsed kinship subject queries to that entity', () => {
    const query = parseQueryTopic('What breed is Hanas sisters dog?');
    expect(findRelationUnstated(['Hana is allergic to peanuts.'], query)).toEqual([true]);
  });
});
