/**
 * Temporal query parsing + validity-at-T unit tests.
 *
 * Covers:
 * - parseTimeReference truth table: every family (past-anchored variants,
 *   past-unanchored cues, current markers, none) plus negatives
 *   ("use" must not match "user", plain factual queries stay 'none').
 * - isValidAt boundary semantics: createdAt == t inclusive, supersededAt == t
 *   exclusive, missing fields.
 * - applyTemporalEligibility scoping: anchored-past excludes post-t memories,
 *   unanchored keeps everything, current/none are no-ops.
 */

import { describe, test, expect } from 'bun:test';

import { parseTimeReference, stripTemporalRelationTokens } from '../../../core/retrieval/temporal-query.js';
import {
  isValidAt,
  applyTemporalEligibility,
  normalizeTimestampValue,
  overlapsValidTimeWindow,
  TEMPORAL_VALID_AT_T_BOOST,
  TEMPORAL_DATE_FIT_BOOST,
  temporalDateFitBoost,
} from '../../../core/retrieval/temporal-validity.js';

function utc(iso: string): Date {
  return new Date(iso);
}

describe('parseTimeReference - past-anchored', () => {
  test('relative past phrases anchor to a fixed clock in the requested IANA zone', () => {
    const referenceDate = utc('2025-08-10T12:00:00.000Z');
    const expected: Array<[string, string]> = [
      ['What did I eat yesterday?', '2025-08-10T06:59:59.999Z'],
      ['Where did I run last night?', '2025-08-10T11:59:59.999Z'],
      ['Where did I run last week?', '2025-08-04T06:59:59.999Z'],
      ['What happened last month?', '2025-08-01T06:59:59.999Z'],
      ['What changed last year?', '2025-01-01T07:59:59.999Z'],
    ];

    for (const [query, instant] of expected) {
      const result = parseTimeReference(query, referenceDate, 'America/Los_Angeles');
      expect(result.kind).toBe('past-anchored');
      expect(result.t?.toISOString()).toBe(instant);
    }
    const lastWeek = parseTimeReference('Where did I run last week?', referenceDate, 'America/Los_Angeles');
    expect(lastWeek.range?.from.toISOString()).toBe('2025-07-28T07:00:00.000Z');
    expect(lastWeek.range?.to.toISOString()).toBe('2025-08-04T07:00:00.000Z');
  });

  test('relative week anchor respects daylight-saving offset at local week boundary', () => {
    const result = parseTimeReference(
      'What happened last week?',
      utc('2024-03-11T08:30:00.000Z'),
      'America/Los_Angeles'
    );
    expect(result.t?.toISOString()).toBe('2024-03-11T06:59:59.999Z');
  });

  test('last weekday resolves to the previous local calendar day across DST', () => {
    const result = parseTimeReference(
      'What did I do last Sunday?',
      utc('2024-03-11T08:30:00.000Z'),
      'America/Los_Angeles'
    );
    expect(result.kind).toBe('past-anchored');
    expect(result.t?.toISOString()).toBe('2024-03-11T06:59:59.999Z');
    expect(result.range?.from.toISOString()).toBe('2024-03-10T08:00:00.000Z');
    expect(result.range?.to.toISOString()).toBe('2024-03-11T07:00:00.000Z');
  });

  test('last weekday on that weekday refers to the prior week', () => {
    const result = parseTimeReference(
      'What happened last Tuesday?',
      utc('2025-08-12T12:00:00.000Z'),
      'UTC'
    );
    expect(result.range?.from.toISOString()).toBe('2025-08-05T00:00:00.000Z');
    expect(result.range?.to.toISOString()).toBe('2025-08-06T00:00:00.000Z');
  });

  test('bare year with preposition uses mid-year convention', () => {
    for (const q of ['in 2021', 'during 2022', 'since 2021', 'back in 2019', 'as of 2023']) {
      const r = parseTimeReference(q);
      expect(r.kind).toBe('past-anchored');
      expect(r.t!.getUTCFullYear()).toBe(Number(q.match(/(20\d{2})/)![1]));
      expect(r.t!.getUTCMonth()).toBe(6); // July
      expect(r.t!.getUTCDate()).toBe(2);
      expect(r.raw).toBeTruthy();
    }
  });

  test('"throughout <year>" anchors past like in/during (Batch B12-4)', () => {
    // The bench temporal-mismatch phrasing that used to escape every anchor
    // pattern and fall through to kind 'none'.
    for (const q of ['throughout 2024', 'What framework did we use throughout 2024?']) {
      const r = parseTimeReference(q);
      expect(r.kind).toBe('past-anchored');
      expect(r.t!.getUTCFullYear()).toBe(2024);
      expect(r.t!.getUTCMonth()).toBe(6); // mid-year convention
      expect(r.t!.getUTCDate()).toBe(2);
    }
  });

  test('"during <year>" and "in <year>" keep anchoring (regression pins)', () => {
    for (const q of ['during 2022', 'in 2023']) {
      const r = parseTimeReference(q);
      expect(r.kind).toBe('past-anchored');
      expect(r.t!.getUTCMonth()).toBe(6);
    }
  });

  test('"throughout <month> <year>" uses the mid-month convention', () => {
    const r = parseTimeReference('used throughout March 2024');
    expect(r.kind).toBe('past-anchored');
    expect(r.t!.toISOString()).toBe('2024-03-15T12:00:00.000Z');
  });

  test('preposition + month + year uses mid-month convention', () => {
    const r = parseTimeReference('What did we use before March 2024?');
    expect(r.kind).toBe('past-anchored');
    expect(r.t!.toISOString()).toBe('2024-03-15T12:00:00.000Z');
    expect(r.raw!.toLowerCase()).toContain('march 2024');
  });

  test('month abbreviation + year', () => {
    const r = parseTimeReference('as of Sept 2023 what was the policy');
    expect(r.kind).toBe('past-anchored');
    expect(r.t!.toISOString()).toBe('2023-09-15T12:00:00.000Z');
  });

  test('ISO date anchors exactly', () => {
    const r = parseTimeReference('status as of 2024-03-15');
    expect(r.kind).toBe('past-anchored');
    // Full ISO dates resolve to that day at the documented mid-point hour.
    expect(r.t!.toISOString()).toBe('2024-03-15T12:00:00.000Z');
  });

  test('explicit calendar anchors use local noon in the requested time zone', () => {
    const result = parseTimeReference('status as of 2024-06-15', undefined, 'Pacific/Kiritimati');
    expect(result.kind).toBe('past-anchored');
    // Kiritimati is UTC+14: UTC noon falls on June 16 locally, while local
    // noon on the requested June 15 date is June 14 at 22:00 UTC.
    expect(result.t?.toISOString()).toBe('2024-06-14T22:00:00.000Z');
  });

  test('impossible ISO dates and months do not normalize into a different temporal anchor', () => {
    for (const query of [
      'status as of 2024-02-30',
      'status as of 2023-02-29',
      'status as of 2024-13-01',
      'config in 2024-13',
    ]) {
      expect(parseTimeReference(query).kind).toBe('none');
    }
    expect(parseTimeReference('status as of 2024-02-29').kind).toBe('past-anchored');
  });

  test('ISO year-month anchors to mid-month', () => {
    const r = parseTimeReference('config in 2022-06');
    expect(r.kind).toBe('past-anchored');
    expect(r.t!.toISOString()).toBe('2022-06-15T12:00:00.000Z');
  });

  test('preposition NOT immediately followed by a year does not anchor', () => {
    // "spring" intervenes: this is the exact golden-eval phrasing that must
    // stay unanchored so its must-hit memories are never excluded by t.
    const r = parseTimeReference('Which annotation platform did the team switch away from in spring 2026?');
    expect(r.kind).not.toBe('past-anchored');
  });
});

describe('overlapsValidTimeWindow', () => {
  test('uses half-open boundaries and includes intervals that overlap the window', () => {
    const windowStart = utc('2024-01-01T00:00:00Z');
    const windowEnd = utc('2024-02-01T00:00:00Z');
    expect(overlapsValidTimeWindow({ validFrom: '2023-12-01T00:00:00Z', validTo: '2024-01-01T00:00:00Z' }, windowStart, windowEnd)).toBe(false);
    expect(overlapsValidTimeWindow({ validFrom: '2023-12-01T00:00:00Z', validTo: '2024-01-02T00:00:00Z' }, windowStart, windowEnd)).toBe(true);
    expect(overlapsValidTimeWindow({ validFrom: '2024-02-01T00:00:00Z' }, windowStart, windowEnd)).toBe(false);
    expect(overlapsValidTimeWindow({ validFrom: '2024-01-15T00:00:00Z' }, windowStart, windowEnd)).toBe(true);
  });
});

describe('parseTimeReference - past-unanchored', () => {
  test('"did ... before" cue', () => {
    const r = parseTimeReference('What phone did Kenji use before?');
    expect(r.kind).toBe('past-unanchored');
    expect(r.t).toBeNull();
    expect(r.raw).toBeTruthy();
  });

  test('"was ... before" cue', () => {
    const r = parseTimeReference('Where was Grove hosted before Fly.io?');
    expect(r.kind).toBe('past-unanchored');
  });

  test('"used to" cue', () => {
    expect(parseTimeReference('What editor did we used to use?').kind).toBe('past-unanchored');
  });

  test('adverb cues', () => {
    for (const q of [
      'What database was used previously?',
      'The formerly supported runtime?',
      'What language was the flint parser originally written in?',
      'What did we discuss earlier?',
    ]) {
      expect(parseTimeReference(q).kind).toBe('past-unanchored');
    }
  });

  test('mirrored "Before ..., what did ..." order', () => {
    expect(parseTimeReference('Before the migration, what did the team use?').kind).toBe(
      'past-unanchored'
    );
  });
});

describe('parseTimeReference - current', () => {
  test('current markers', () => {
    for (const q of [
      'What framework does the team use currently?',
      'What phone does Kenji use now?',
      'What is the status today?',
      'How often are reviews held these days?',
      'Who is on call right now?',
      'Who is the owner at present?',
    ]) {
      const r = parseTimeReference(q);
      expect(r.kind).toBe('current');
      expect(r.t).toBeNull();
    }
  });

  test('current marker uses an explicitly supplied fixed clock', () => {
    const fixed = utc('2025-08-10T12:00:00Z');
    expect(parseTimeReference('What is current now?', fixed).t?.toISOString()).toBe(fixed.toISOString());
  });
});

describe('parseTimeReference - none + negatives', () => {
  test('plain factual queries do not trigger any temporal family', () => {
    for (const q of [
      'What phone does Kenji use?',
      'What is PaperTrail?',
      'Which project depends on PaperTrail and why?',
      'Do we still use MongoDB anywhere?',
      'Was Redis rejected for anything?',
      '',
    ]) {
      const r = parseTimeReference(q);
      expect(r.kind).toBe('none');
      expect(r.t).toBeNull();
      expect(r.raw).toBeNull();
    }
  });

  test('future-action language is not a memory valid-time filter', () => {
    const query = parseTimeReference('Plan workouts for next week.', new Date('2022-01-01T00:00:00.000Z'));
    expect(query.kind).toBe('none');
    expect(query.t).toBeNull();
    expect(parseTimeReference('Schedule the run for next Tuesday.', new Date('2025-08-10T12:00:00.000Z')).kind).toBe('none');
  });

  test('"use" must not match "user"', () => {
    // Contains neither a past cue nor a current marker; specifically guards
    // against substring accidents around use/user/used.
    const r = parseTimeReference('Which user to page for incidents?');
    expect(r.kind).toBe('none');
  });

  test('preference-style "before bed" stays none (no past auxiliary)', () => {
    expect(parseTimeReference('What does Greta read before bed?').kind).toBe('none');
    expect(parseTimeReference('What does Olive do before standup meetings?').kind).toBe('none');
  });

  test('precedence: anchored beats later current markers', () => {
    const r = parseTimeReference('in 2021 vs now');
    expect(r.kind).toBe('past-anchored');
  });
});

describe('normalizeTimestampValue', () => {
  test('handles every storage shape', () => {
    expect(normalizeTimestampValue(new Date('2024-03-15T12:00:00Z'))).toBe(
      Date.UTC(2024, 2, 15, 12)
    );
    expect(normalizeTimestampValue('2024-03-15T12:00:00.000Z')).toBe(Date.UTC(2024, 2, 15, 12));
    // epoch seconds (< 1e11) -> ms
    expect(normalizeTimestampValue(1700000000)).toBe(1700000000000);
    expect(normalizeTimestampValue('1700000000')).toBe(1700000000000);
    // epoch ms passes through
    expect(normalizeTimestampValue(1700000000000)).toBe(1700000000000);
  });

  test('null/undefined/garbage -> null', () => {
    expect(normalizeTimestampValue(null)).toBeNull();
    expect(normalizeTimestampValue(undefined)).toBeNull();
    expect(normalizeTimestampValue('not-a-date')).toBeNull();
    expect(normalizeTimestampValue(new Date('garbage'))).toBeNull();
  });
});

describe('isValidAt', () => {
  const t = utc('2023-07-02T12:00:00Z');

  test('valid when created before t and never superseded', () => {
    expect(isValidAt({ createdAt: '2023-01-01T00:00:00Z' }, t)).toBe(true);
  });

  test('createdAt == t boundary is INCLUSIVE', () => {
    expect(isValidAt({ createdAt: '2023-07-02T12:00:00Z' }, t)).toBe(true);
  });

  test('createdAt after t is invalid', () => {
    expect(isValidAt({ createdAt: '2026-08-25T00:00:00Z' }, t)).toBe(false);
  });

  test('uses source valid-time intervals for delayed imports', () => {
    const importedLater = {
      createdAt: '2025-01-01T00:00:00Z',
      validFrom: '2022-03-01T00:00:00Z',
      validTo: '2022-12-01T00:00:00Z',
    };
    expect(isValidAt(importedLater, utc('2022-06-01T00:00:00Z'))).toBe(true);
    expect(isValidAt(importedLater, utc('2023-01-01T00:00:00Z'))).toBe(false);
  });

  test('supersededAt == t boundary is EXCLUSIVE (invalid at t)', () => {
    expect(
      isValidAt(
        { createdAt: '2022-01-01T00:00:00Z', supersededAt: '2023-07-02T12:00:00Z' },
        t
      )
    ).toBe(false);
  });

  test('superseded strictly after t stays valid at t', () => {
    expect(
      isValidAt(
        { createdAt: '2022-01-01T00:00:00Z', supersededAt: '2026-01-01T00:00:00Z' },
        t
      )
    ).toBe(true);
  });

  test('missing fields follow the documented strictness', () => {
    // No createdAt: cannot establish existence at t -> not valid.
    expect(isValidAt({}, t)).toBe(false);
    // Unparseable createdAt behaves like missing.
    expect(isValidAt({ createdAt: 'garbage' }, t)).toBe(false);
    // Missing supersededAt means never invalidated.
    expect(isValidAt({ createdAt: '2020-01-01T00:00:00Z', supersededAt: null }, t)).toBe(true);
    // Unparseable supersededAt treated as missing (never invalidated).
    expect(
      isValidAt({ createdAt: '2020-01-01T00:00:00Z', supersededAt: 'n/a' }, t)
    ).toBe(true);
  });
});

describe('stripTemporalRelationTokens', () => {
  test('removes temporal relation words, keeps subject terms', () => {
    expect(
      stripTemporalRelationTokens('What database did the atlas project use before the MySQL experiment?')
    ).toBe('What database did the atlas project use the MySQL experiment?');
  });

  test('whole-word matching only (no substring damage)', () => {
    // "beforehand"/"aftermath" survive; standalone words do not.
    expect(stripTemporalRelationTokens('checklist beforehand')).toBe('checklist beforehand');
    expect(stripTemporalRelationTokens('aftermath of the outage')).toBe('aftermath of the outage');
    expect(stripTemporalRelationTokens('since when')).toBe('when');
  });

  test('case-insensitive and whitespace-collapsing', () => {
    expect(stripTemporalRelationTokens('What was deployed BEFORE the incident?')).toBe(
      'What was deployed the incident?'
    );
  });

  test('empty-safe', () => {
    expect(stripTemporalRelationTokens('')).toBe('');
    expect(stripTemporalRelationTokens('before')).toBe('');
  });
});

describe('applyTemporalEligibility', () => {
  const nokia = { id: 'nokia', createdAt: '2023-06-15T00:00:00Z', supersededAt: '2026-08-25T00:00:00Z' };
  const iphone = { id: 'iphone', createdAt: '2026-08-25T00:00:00Z' };
  const anchored = parseTimeReference('What phone did Kenji use in 2023?');

  test('anchored past excludes memories created after t and boosts valid ones', () => {
    const verdicts = applyTemporalEligibility([nokia, iphone], anchored);
    expect(verdicts[0].eligible).toBe(true);
    expect(verdicts[0].boost).toBe(TEMPORAL_VALID_AT_T_BOOST);
    expect(verdicts[1].eligible).toBe(false);
    expect(verdicts[1].boost).toBe(0);
  });

  test('anchored past excludes memories invalidated before t', () => {
    const old = { id: 'old', createdAt: '2020-01-01T00:00:00Z', supersededAt: '2021-01-01T00:00:00Z' };
    const verdicts = applyTemporalEligibility([old], anchored);
    expect(verdicts[0].eligible).toBe(false);
  });

  test('unanchored past keeps everything eligible with zero boost', () => {
    const unanchored = parseTimeReference('What phone did Kenji use before?');
    const verdicts = applyTemporalEligibility([nokia, iphone], unanchored);
    expect(verdicts.map(v => v.eligible)).toEqual([true, true]);
    expect(verdicts.map(v => v.boost)).toEqual([0, 0]);
  });

  test('current and none are full no-ops', () => {
    for (const ref of [parseTimeReference('What phone does Kenji use now?'), parseTimeReference('What phone does Kenji use?')]) {
      const verdicts = applyTemporalEligibility([nokia, iphone], ref);
      expect(verdicts.map(v => v.eligible)).toEqual([true, true]);
      expect(verdicts.map(v => v.boost)).toEqual([0, 0]);
    }
  });

  test('result array is index-aligned with candidates', () => {
    const verdicts = applyTemporalEligibility([iphone, nokia], anchored);
    expect(verdicts[0].eligible).toBe(false); // iphone (created after t)
    expect(verdicts[1].eligible).toBe(true); // nokia
  });
});

describe('temporalDateFitBoost', () => {
  const range = parseTimeReference('What happened last week?', utc('2025-08-10T12:00:00Z'), 'America/Los_Angeles');

  test('boosts event time inside the half-open relative window without eligibility effects', () => {
    expect(temporalDateFitBoost({ validFrom: '2025-08-01T12:00:00Z' }, range)).toBe(TEMPORAL_DATE_FIT_BOOST);
    expect(temporalDateFitBoost({ validFrom: '2025-07-18T12:00:00Z' }, range)).toBe(0);
    expect(temporalDateFitBoost({ validFrom: '2025-08-04T07:00:00Z' }, range)).toBe(0);
  });

  test('explicit point anchors do not acquire date-fit boosts', () => {
    const explicit = parseTimeReference('What happened in 2025?', utc('2025-08-10T12:00:00Z'));
    expect(temporalDateFitBoost({ validFrom: '2025-08-01T12:00:00Z' }, explicit)).toBe(0);
  });
});
