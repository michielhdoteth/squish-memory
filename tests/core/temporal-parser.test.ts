import { describe, expect, test } from 'bun:test';
import { parseTemporalFacts } from '../../core/memory/temporal-parser.js';

describe('temporal parser relative offsets', () => {
  test('anchors numeric prefix offsets to the full source instant', async () => {
    const referenceDate = new Date('2024-01-31T15:45:22.123Z');
    const facts = await parseTemporalFacts('The review is in 2 weeks.', referenceDate);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ type: 'relative', value: 'in 2 weeks' });
    expect(facts[0]?.parsed.start?.toISOString()).toBe('2024-02-14T15:45:22.123Z');
    expect(facts[0]?.parsed.end?.toISOString()).toBe('2024-02-14T15:45:22.123Z');
    expect(facts[0]?.parsed.precision).toBe('day');
  });

  test('clamps month offsets to the last valid calendar day', async () => {
    const referenceDate = new Date('2024-01-31T15:45:22.123Z');
    const future = await parseTemporalFacts('Renew 1 month from now.', referenceDate);
    const past = await parseTemporalFacts('Renewed 1 month ago.', referenceDate);

    expect(future.find((fact) => fact.type === 'relative')?.parsed.start?.toISOString())
      .toBe('2024-02-29T15:45:22.123Z');
    expect(future.find((fact) => fact.type === 'relative')?.parsed.end?.toISOString())
      .toBe('2024-02-29T15:45:22.123Z');
    expect(past.find((fact) => fact.type === 'relative')?.parsed.start?.toISOString())
      .toBe('2023-12-31T15:45:22.123Z');
  });

  test('clamps named month and year expressions at leap-day boundaries', async () => {
    const monthFacts = await parseTemporalFacts('The review is next month.', new Date('2024-01-31T15:45:22.123Z'));
    const yearFacts = await parseTemporalFacts('The review is next year.', new Date('2024-02-29T15:45:22.123Z'));

    expect(monthFacts[0]?.parsed.start?.toISOString()).toBe('2024-02-01T00:00:00.000Z');
    expect(monthFacts[0]?.parsed.end?.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(yearFacts[0]?.parsed.start?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(yearFacts[0]?.parsed.end?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('uses UTC calendar days for day offsets across month and year boundaries', async () => {
    const referenceDate = new Date('2024-12-31T23:30:00.456Z');
    const facts = await parseTemporalFacts('The review is in 2 days.', referenceDate);

    expect(facts[0]?.parsed.start?.toISOString()).toBe('2025-01-02T23:30:00.456Z');
    expect(facts[0]?.parsed.end?.toISOString()).toBe('2025-01-02T23:30:00.456Z');
  });
});

describe('temporal parser coarse calendar precision', () => {
  test('rejects impossible ISO calendar dates instead of normalizing into another month', async () => {
    const dateOnly = await parseTemporalFacts('The appointment is on 2024-02-30.');
    const timestamp = await parseTemporalFacts('The appointment is at 2024-02-30T10:30:00Z.');

    expect(dateOnly).toEqual([]);
    expect(timestamp).toEqual([]);
  });

  test('preserves a date-only ISO expression as a one-day half-open range', async () => {
    const facts = await parseTemporalFacts('The review happened on 2024-06-15.');
    const fact = facts.find((item) => item.type === 'absolute');

    expect(fact?.parsed.start?.toISOString()).toBe('2024-06-15T00:00:00.000Z');
    expect(fact?.parsed.end?.toISOString()).toBe('2024-06-16T00:00:00.000Z');
    expect(fact?.parsed.precision).toBe('day');
  });

  test('preserves month-only and year-only expressions as calendar ranges', async () => {
    const facts = await parseTemporalFacts('The pilot ran in June 2025 and expanded in 2026.');
    const months = facts.find((item) => item.value === 'June 2025');
    const years = facts.find((item) => item.value === '2026');

    expect(months?.parsed.start?.toISOString()).toBe('2025-06-01T00:00:00.000Z');
    expect(months?.parsed.end?.toISOString()).toBe('2025-07-01T00:00:00.000Z');
    expect(months?.parsed.precision).toBe('month');
    expect(years?.parsed.start?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(years?.parsed.end?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(years?.parsed.precision).toBe('year');
  });

  test('keeps explicitly timestamped ISO expressions at instant precision', async () => {
    const facts = await parseTemporalFacts('The review happened at 2024-06-15T10:30:00Z.');
    const fact = facts.find((item) => item.type === 'absolute');

    expect(fact?.parsed.start?.toISOString()).toBe('2024-06-15T10:30:00.000Z');
    expect(fact?.parsed.end?.toISOString()).toBe('2024-06-15T10:30:00.000Z');
    expect(fact?.parsed.precision).toBe('instant');
  });

  test('treats a named day as a day range without adding a separate year fact', async () => {
    const facts = await parseTemporalFacts('The event was January 5, 2024.');
    const absoluteFacts = facts.filter((item) => item.type === 'absolute');

    expect(absoluteFacts).toHaveLength(1);
    expect(absoluteFacts[0]?.parsed.start?.toISOString()).toBe('2024-01-05T00:00:00.000Z');
    expect(absoluteFacts[0]?.parsed.end?.toISOString()).toBe('2024-01-06T00:00:00.000Z');
    expect(absoluteFacts[0]?.parsed.precision).toBe('day');
  });

  test('preserves the calendar ranges and precision of relative periods', async () => {
    const referenceDate = new Date('2024-06-15T10:30:00.000Z');
    const yesterday = await parseTemporalFacts('The check-in was yesterday.', referenceDate);
    const lastWeek = await parseTemporalFacts('The check-in was last week.', referenceDate);
    const lastMonth = await parseTemporalFacts('The check-in was last month.', referenceDate);
    const lastYear = await parseTemporalFacts('The check-in was last year.', referenceDate);

    expect(yesterday[0]?.parsed).toMatchObject({ precision: 'day' });
    expect(yesterday[0]?.parsed.start?.toISOString()).toBe('2024-06-14T00:00:00.000Z');
    expect(yesterday[0]?.parsed.end?.toISOString()).toBe('2024-06-15T00:00:00.000Z');
    expect(lastWeek[0]?.parsed).toMatchObject({ precision: 'week' });
    expect(lastWeek[0]?.parsed.start?.toISOString()).toBe('2024-06-03T00:00:00.000Z');
    expect(lastWeek[0]?.parsed.end?.toISOString()).toBe('2024-06-10T00:00:00.000Z');
    expect(lastMonth[0]?.parsed).toMatchObject({ precision: 'month' });
    expect(lastMonth[0]?.parsed.start?.toISOString()).toBe('2024-05-01T00:00:00.000Z');
    expect(lastMonth[0]?.parsed.end?.toISOString()).toBe('2024-06-01T00:00:00.000Z');
    expect(lastYear[0]?.parsed).toMatchObject({ precision: 'year' });
    expect(lastYear[0]?.parsed.start?.toISOString()).toBe('2023-01-01T00:00:00.000Z');
    expect(lastYear[0]?.parsed.end?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });
});

describe('temporal parser IANA time zones', () => {
  test('uses source-zone calendar days and handles a 23-hour DST day', async () => {
    const facts = await parseTemporalFacts(
      'The race is today.',
      new Date('2024-03-10T08:30:00.000Z'),
      { timeZone: 'America/Los_Angeles' },
    );
    expect(facts[0]?.parsed.start?.toISOString()).toBe('2024-03-10T08:00:00.000Z');
    expect(facts[0]?.parsed.end?.toISOString()).toBe('2024-03-11T07:00:00.000Z');
  });

  test('uses local week and month boundaries across seasonal offset changes', async () => {
    const referenceDate = new Date('2024-03-11T08:30:00.000Z');
    const week = await parseTemporalFacts('The review happened last week.', referenceDate, { timeZone: 'America/Los_Angeles' });
    const month = await parseTemporalFacts('The review is next month.', referenceDate, { timeZone: 'America/Los_Angeles' });
    expect(week[0]?.parsed.start?.toISOString()).toBe('2024-03-04T08:00:00.000Z');
    expect(week[0]?.parsed.end?.toISOString()).toBe('2024-03-11T07:00:00.000Z');
    expect(month[0]?.parsed.start?.toISOString()).toBe('2024-04-01T07:00:00.000Z');
    expect(month[0]?.parsed.end?.toISOString()).toBe('2024-05-01T07:00:00.000Z');
  });

  test('interprets source timestamps without an offset in the supplied zone', async () => {
    const facts = await parseTemporalFacts(
      'The check-in was at 2024-11-03T01:30:00.',
      new Date('2024-11-03T12:00:00.000Z'),
      { timeZone: 'America/Los_Angeles' },
    );
    expect(facts.find((fact) => fact.type === 'absolute')?.parsed.start?.toISOString())
      .toBe('2024-11-03T08:30:00.000Z');
  });

  test('preserves an explicit ISO offset instead of reinterpreting it in the source zone', async () => {
    const facts = await parseTemporalFacts(
      'The check-in was at 2024-06-15T10:30:00-05:00.',
      new Date('2024-06-15T12:00:00.000Z'),
      { timeZone: 'America/Los_Angeles' },
    );
    expect(facts.find((fact) => fact.type === 'absolute')?.parsed.start?.toISOString())
      .toBe('2024-06-15T15:30:00.000Z');
  });

  test('keeps the source local clock time when adding calendar days across DST', async () => {
    const facts = await parseTemporalFacts(
      'The appointment is in 1 day.',
      new Date('2024-03-10T08:30:00.000Z'),
      { timeZone: 'America/Los_Angeles' },
    );
    expect(facts[0]?.parsed.start?.toISOString()).toBe('2024-03-11T07:30:00.000Z');
    expect(facts[0]?.parsed.end?.toISOString()).toBe('2024-03-11T07:30:00.000Z');
  });

  test('moves a nonexistent local clock time forward to the first valid minute', async () => {
    const facts = await parseTemporalFacts(
      'The check-in was at 2024-03-10T02:30:00.',
      new Date('2024-03-10T12:00:00.000Z'),
      { timeZone: 'America/Los_Angeles' },
    );
    expect(facts.find((fact) => fact.type === 'absolute')?.parsed.start?.toISOString())
      .toBe('2024-03-10T10:00:00.000Z');
  });

  test('rejects invalid zones instead of silently interpreting them as UTC', async () => {
    await expect(parseTemporalFacts('The event is today.', new Date(), { timeZone: 'Mars/Olympus' }))
      .rejects.toThrow('Invalid IANA time zone');
  });
});
