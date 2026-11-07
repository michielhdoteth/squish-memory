/**
 * Temporal Parser
 * Parses temporal expressions and creates time-based relationships between memories
 * Handles absolute dates, relative times, durations, and frequencies
 */

import { createAssociation } from '../../core/associations.js';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';

export type TemporalExpressionType = 'absolute' | 'relative' | 'duration' | 'frequency';

export interface TemporalFact {
  type: TemporalExpressionType;
  value: string;
  parsed: {
    start?: Date;
    /** Exclusive interval end; equals start for a relative offset anchored to an instant. */
    end?: Date;
    precision?: 'instant' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
    duration?: number; // in milliseconds
    frequency?: string;
  };
  confidence: number; // 0-1
  context: string;
}

export interface TemporalRelation {
  type: 'before' | 'after' | 'during' | 'overlaps' | 'supersedes' | 'contradicts';
  targetMemoryId: string;
  confidence: number;
}

export interface TemporalParseOptions {
  /** IANA zone used to interpret date-only and relative calendar expressions. */
  timeZone?: string;
}

export function normalizeIanaTimeZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new RangeError(`Invalid IANA time zone: ${timeZone}`);
  }
}

// Regex patterns for temporal expression detection
const PATTERNS = {
  // ISO dates: 2024-01-05, 2024-01-05T10:30:00Z
  isoDate: /\b(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,

  // ISO year-month without a day, and month/year written in words.
  isoYearMonth: /\b(\d{4})-(0[1-9]|1[0-2])\b(?!-\d{2})/g,
  naturalMonthYear: /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\b/gi,
  year: /\b(?:19\d{2}|20\d{2}|21\d{2})\b/g,

  // Natural dates: January 5, Jan 5, 1/5/2024, 01-05-2024
  naturalDate: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,?\s+\d{4})?\b/gi,

  // Relative times: yesterday, today, tomorrow, last week, next month
  relativeTime: /\b(?:yesterday|today|tomorrow|last\s+(?:week|month|year|day|hour)|next\s+(?:week|month|year|day|hour))\b/gi,

  // Time offsets: 3 days ago, 3 weeks from now, in 2 weeks
  timeOffset: /\b(?:(in)\s+(\d+)\s+(days?|weeks?|months?|years?|hours?|minutes?|seconds?)|(\d+)\s+(days?|weeks?|months?|years?|hours?|minutes?|seconds?)\s+(?:ago|from now|in the past|in the future))\b/gi,

  // Durations: for 2 hours, over 3 weeks, during 5 days
  duration: /\b(?:for|during|over)\s+(\d+)\s+(?:days?|weeks?|months?|years?|hours?|minutes?|seconds?)\b/gi,

  // Frequencies: daily, weekly, monthly, every week, once a month
  frequency: /\b(?:daily|weekly|monthly|yearly|hourly|every\s+(?:day|week|month|year)|once\s+a\s+(?:day|week|month|year))\b/gi,
};

/**
 * Parse temporal expressions from content
 */
export async function parseTemporalFacts(
  content: string,
  referenceDate: Date = new Date(),
  options: TemporalParseOptions = {},
): Promise<TemporalFact[]> {
  const timeZone = options.timeZone ? normalizeIanaTimeZone(options.timeZone) : 'UTC';
  const facts: TemporalFact[] = [];

  // Parse absolute dates (ISO and natural format)
  const isoDates = Array.from(content.matchAll(PATTERNS.isoDate));
  const naturalDates = Array.from(content.matchAll(PATTERNS.naturalDate));
  for (const match of isoDates) {
    try {
      const calendarDate = match[0].match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!calendarDate || !isValidCalendarDate(Number(calendarDate[1]), Number(calendarDate[2]), Number(calendarDate[3]))) {
        continue;
      }
      const date = match[0].includes('T')
        ? parseIsoInstant(match[0], timeZone)
        : new Date(`${match[0]}T00:00:00.000Z`);
      if (!isNaN(date.getTime())) {
        const isTimestamp = match[0].includes('T');
        const start = isTimestamp
          ? date
          : localDateStart(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), timeZone);
        facts.push({
          type: 'absolute',
          value: match[0],
          parsed: isTimestamp
            ? { start, end: start, precision: 'instant' }
            : { start, end: localDateStart(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, timeZone), precision: 'day' },
          confidence: 0.95,
          context: extractContext(content, match.index || 0),
        });
      }
    } catch {
      // Invalid date format
    }
  }

  const isoYearMonths = Array.from(content.matchAll(PATTERNS.isoYearMonth));
  for (const match of isoYearMonths) {
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const start = localDateStart(year, monthIndex, 1, timeZone);
    facts.push({
      type: 'absolute',
      value: match[0],
      parsed: { start, end: localDateStart(year, monthIndex + 1, 1, timeZone), precision: 'month' },
      confidence: 0.95,
      context: extractContext(content, match.index || 0),
    });
  }

  const monthYears = Array.from(content.matchAll(PATTERNS.naturalMonthYear));
  for (const match of monthYears) {
    const monthIndex = monthIndexFromName(match[1] ?? '');
    if (monthIndex < 0) continue;
    const year = Number(match[2]);
    const start = localDateStart(year, monthIndex, 1, timeZone);
    facts.push({
      type: 'absolute',
      value: match[0],
      parsed: { start, end: localDateStart(year, monthIndex + 1, 1, timeZone), precision: 'month' },
      confidence: 0.9,
      context: extractContext(content, match.index || 0),
    });
  }

  const years = Array.from(content.matchAll(PATTERNS.year));
  for (const match of years) {
    const index = match.index || 0;
    const overlapsMonthYear = monthYears.some((monthYear) => {
      const monthStart = monthYear.index || 0;
      return index >= monthStart && index < monthStart + monthYear[0].length;
    });
    const overlapsIsoDate = isoDates.some((isoDate) => {
      const isoStart = isoDate.index || 0;
      return index >= isoStart && index < isoStart + isoDate[0].length;
    });
    const overlapsIsoYearMonth = isoYearMonths.some((isoMonth) => {
      const isoStart = isoMonth.index || 0;
      return index >= isoStart && index < isoStart + isoMonth[0].length;
    });
    const overlapsNaturalDate = naturalDates.some((naturalDate) => {
      const dateStart = naturalDate.index || 0;
      return index >= dateStart && index < dateStart + naturalDate[0].length;
    });
    if (overlapsMonthYear || overlapsIsoDate || overlapsIsoYearMonth || overlapsNaturalDate) continue;

    const year = Number(match[0]);
    const start = localDateStart(year, 0, 1, timeZone);
    facts.push({
      type: 'absolute',
      value: match[0],
      parsed: { start, end: localDateStart(year + 1, 0, 1, timeZone), precision: 'year' },
      confidence: 0.85,
      context: extractContext(content, index),
    });
  }

  for (const match of naturalDates) {
    try {
      const date = parseNaturalDate(match[0], referenceDate, timeZone);
      if (date) {
        const start = localDateStart(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), timeZone);
        facts.push({
          type: 'absolute',
          value: match[0],
          parsed: { start, end: localDateStart(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, timeZone), precision: 'day' },
          confidence: 0.85,
          context: extractContext(content, match.index || 0),
        });
      }
    } catch {
      // Invalid date format
    }
  }

  // Parse relative times
  const relativeTimes = Array.from(content.matchAll(PATTERNS.relativeTime));
  for (const match of relativeTimes) {
    const parsed = parseRelativeTimeRange(match[0], referenceDate, timeZone);
    if (parsed) {
      facts.push({
        type: 'relative',
        value: match[0],
        parsed,
        confidence: 0.9,
        context: extractContext(content, match.index || 0),
      });
    }
  }

  // Parse time offsets (3 days ago, in 2 weeks, etc.)
  const timeOffsets = Array.from(content.matchAll(PATTERNS.timeOffset));
  for (const match of timeOffsets) {
    const amount = parseInt(match[2] ?? match[4] ?? '0');
    const unit = (match[3] ?? match[5] ?? '').toLowerCase();
    const parsed = calculateOffsetRange(referenceDate, amount, unit, match[0], timeZone);
    if (parsed) {
      facts.push({
        type: 'relative',
        value: match[0],
        parsed,
        confidence: 0.85,
        context: extractContext(content, match.index || 0),
      });
    }
  }

  // Parse durations
  const durations = Array.from(content.matchAll(PATTERNS.duration));
  for (const match of durations) {
    const amount = parseInt(match[1]);
    const unit = match[0].split(/\s+/)[2].toLowerCase();
    const durationMs = calculateDurationMs(amount, unit);
    if (durationMs > 0) {
      facts.push({
        type: 'duration',
        value: match[0],
        parsed: { duration: durationMs },
        confidence: 0.8,
        context: extractContext(content, match.index || 0),
      });
    }
  }

  // Parse frequencies
  const frequencies = Array.from(content.matchAll(PATTERNS.frequency));
  for (const match of frequencies) {
    facts.push({
      type: 'frequency',
      value: match[0],
      parsed: { frequency: match[0].toLowerCase() },
      confidence: 0.85,
      context: extractContext(content, match.index || 0),
    });
  }

  return facts;
}

/**
 * Link temporal relations between memories
 */
export async function linkTemporalRelations(
  memoryId: string,
  facts: TemporalFact[]
): Promise<TemporalRelation[]> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(memoryId, 'memory', 'Unscoped temporal relation linking is disabled under strict trust');
  }

  const relations: TemporalRelation[] = [];

  if (facts.length === 0) return relations;

  try {
    const db = await getDb();
    const schema = await getSchema();

    // Get the target memory
    const targetMemories = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .limit(1);

    if (targetMemories.length === 0) return relations;
    const targetMemory = targetMemories[0];

    // Find related memories with temporal overlaps
    const allMemories = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.projectId, targetMemory.projectId));

    for (const fact of facts) {
      if (!fact.parsed.start) continue;

      for (const otherMemory of allMemories) {
        if (otherMemory.id === memoryId) continue;

        const relation = analyzeTemporalRelation(
          fact,
          targetMemory,
          otherMemory
        );

        if (relation) {
          relations.push(relation);

          // Create association for temporal relationships
          if (relation.type === 'supersedes') {
            await createAssociation(memoryId, otherMemory.id, 'supersedes', relation.confidence);
          } else if (relation.type === 'contradicts') {
            await createAssociation(memoryId, otherMemory.id, 'contradicts', relation.confidence);
          }
        }
      }
    }

    // Update memory validity dates if we have absolute dates
    const absoluteFacts = facts.filter((f) => f.type === 'absolute');
    if (absoluteFacts.length > 0) {
      const dates = absoluteFacts
        .map((f) => f.parsed.start)
        .filter((d) => d) as Date[];

      if (dates.length > 0) {
        const minDate = new Date(Math.min(...dates.map((d) => d.getTime())));
        const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));

        await (db as any)
          .update(schema.memories)
          .set({
            validFrom: minDate,
            validTo: maxDate,
            updatedAt: new Date(),
          })
          .where(eq(schema.memories.id, memoryId));
      }
    }

    logger.debug('Temporal relations linked', {
      memoryId,
      factCount: facts.length,
      relationCount: relations.length,
    });
  } catch (error) {
    logger.error('Error linking temporal relations', error);
  }

  return relations;
}

/**
 * Analyze temporal relationship between two memories
 */
function analyzeTemporalRelation(
  fact: TemporalFact,
  targetMemory: any,
  otherMemory: any
): TemporalRelation | null {
  if (!fact.parsed.start || !otherMemory.validFrom) return null;

  const factDate = fact.parsed.start;
  const otherStart = new Date(otherMemory.validFrom);
  const otherEnd = otherMemory.validTo ? new Date(otherMemory.validTo) : otherStart;

  // Determine temporal relationship
  if (factDate < otherStart) {
    return {
      type: 'before',
      targetMemoryId: otherMemory.id,
      confidence: 0.9,
    };
  }

  if (factDate > otherEnd) {
    return {
      type: 'after',
      targetMemoryId: otherMemory.id,
      confidence: 0.9,
    };
  }

  // Check for overlaps or containment
  if (factDate >= otherStart && factDate <= otherEnd) {
    // Check if this memory supersedes or contradicts
    const contentSimilarity = calculateContentSimilarity(
      targetMemory.content,
      otherMemory.content
    );

    if (contentSimilarity > 0.7) {
      // High similarity with different dates suggests supersession or contradiction
      return {
        type: targetMemory.createdAt > otherMemory.createdAt ? 'supersedes' : 'contradicts',
        targetMemoryId: otherMemory.id,
        confidence: contentSimilarity * 0.9,
      };
    }

    return {
      type: 'overlaps',
      targetMemoryId: otherMemory.id,
      confidence: 0.7,
    };
  }

  return null;
}

/**
 * Parse natural date formats (e.g., "January 5", "Jan 5, 2024")
 */
function parseNaturalDate(dateStr: string, referenceDate: Date, timeZone: string): Date | null {
  const match = dateStr.match(/^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i);
  if (!match) return null;
  const month = monthIndexFromName(match[1] ?? '');
  const day = Number(match[2]);
  const year = Number(match[3] ?? localDateParts(referenceDate, timeZone).year);
  if (month < 0 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month && check.getUTCDate() === day
    ? check
    : null;
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function localDateParts(date: Date, timeZone: string): LocalParts {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(values.find((item) => item.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute'), second: part('second') };
}

function localDateStart(year: number, monthIndex: number, day: number, timeZone: string): Date {
  const civil = new Date(Date.UTC(year, monthIndex, day));
  return localDateTimeToUtc({
    year: civil.getUTCFullYear(), month: civil.getUTCMonth() + 1, day: civil.getUTCDate(),
    hour: 0, minute: 0, second: 0,
  }, timeZone);
}

function parseIsoInstant(value: string, timeZone: string): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  const dateParts = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dateParts || !isValidCalendarDate(Number(dateParts[1]), Number(dateParts[2]), Number(dateParts[3]))) {
    return new Date(Number.NaN);
  }
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    return new Date(value);
  }
  if (!match) return new Date(Number.NaN);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  const wholeSecond = localDateTimeToUtc({
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]),
  }, timeZone);
  wholeSecond.setUTCMilliseconds(millisecond);
  return wholeSecond;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function localDateTimeToUtc(target: LocalParts, timeZone: string): Date {
  const wallClockUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  const offsets = new Set<number>();
  for (const probe of [wallClockUtc - 36 * 60 * 60_000, wallClockUtc, wallClockUtc + 36 * 60 * 60_000]) {
    const parts = localDateParts(new Date(probe), timeZone);
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    offsets.add(representedAsUtc - probe);
  }
  const matches: number[] = [];
  for (const offset of offsets) {
    const candidate = wallClockUtc - offset;
    const parts = localDateParts(new Date(candidate), timeZone);
    if (parts.year === target.year && parts.month === target.month && parts.day === target.day &&
        parts.hour === target.hour && parts.minute === target.minute && parts.second === target.second) {
      matches.push(candidate);
    }
  }
  if (matches.length) return new Date(Math.min(...matches));

  // A local clock gap can make midnight nonexistent. Advance to the first
  // representable minute after the gap; ambiguous times choose the earlier instant.
  for (let minute = 1; minute <= 180; minute += 1) {
    const shifted = new Date(Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute + minute, target.second));
    const next: LocalParts = { ...target, year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds() };
    const result = localDateTimeToUtcExact(next, timeZone, offsets);
    if (result !== null) return new Date(result);
  }
  throw new RangeError(`Could not resolve local time in ${timeZone}`);
}

function localDateTimeToUtcExact(target: LocalParts, timeZone: string, offsets: Set<number>): number | null {
  const wallClockUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute, target.second);
  const matches = [...offsets].map((offset) => wallClockUtc - offset).filter((candidate) => {
    const parts = localDateParts(new Date(candidate), timeZone);
    return parts.year === target.year && parts.month === target.month && parts.day === target.day &&
      parts.hour === target.hour && parts.minute === target.minute && parts.second === target.second;
  });
  return matches.length ? Math.min(...matches) : null;
}

function monthIndexFromName(name: string): number {
  const normalized = name.toLowerCase().slice(0, 3);
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .indexOf(normalized);
}

function shiftUtcDay(date: Date, amount: number): Date {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + amount);
  return shifted;
}

function addUtcMonths(date: Date, amount: number): Date {
  const shifted = new Date(date);
  shiftUtcMonth(shifted, amount);
  return shifted;
}

/**
 * Parse relative time expressions
 */
function parseRelativeTimeRange(
  timeStr: string,
  referenceDate: Date,
  timeZone: string,
): TemporalFact['parsed'] | null {
  const str = timeStr.toLowerCase();
  const local = localDateParts(referenceDate, timeZone);
  const dayStart = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const dayOffset = str === 'yesterday' || str === 'last day' ? -1
    : str === 'tomorrow' || str === 'next day' ? 1
      : str === 'today' ? 0 : null;
  if (dayOffset !== null) {
    const startDay = shiftUtcDay(dayStart, dayOffset);
    const endDay = shiftUtcDay(startDay, 1);
    return { start: localDateStart(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate(), timeZone),
      end: localDateStart(endDay.getUTCFullYear(), endDay.getUTCMonth(), endDay.getUTCDate(), timeZone), precision: 'day' };
  }

  if (str === 'last week' || str === 'next week') {
    const currentWeekStart = shiftUtcDay(dayStart, -((dayStart.getUTCDay() + 6) % 7));
    const weekOffset = str === 'last week' ? -1 : 1;
    const start = shiftUtcDay(currentWeekStart, weekOffset * 7);
    const end = shiftUtcDay(start, 7);
    return { start: localDateStart(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), timeZone),
      end: localDateStart(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), timeZone), precision: 'week' };
  }

  if (str === 'last month' || str === 'next month') {
    const currentMonthStart = new Date(Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), 1));
    const start = addUtcMonths(currentMonthStart, str === 'last month' ? -1 : 1);
    return { start: localDateStart(start.getUTCFullYear(), start.getUTCMonth(), 1, timeZone),
      end: localDateStart(start.getUTCFullYear(), start.getUTCMonth() + 1, 1, timeZone), precision: 'month' };
  }

  if (str === 'last year' || str === 'next year') {
    const yearOffset = str === 'last year' ? -1 : 1;
    const year = dayStart.getUTCFullYear() + yearOffset;
    return { start: localDateStart(year, 0, 1, timeZone), end: localDateStart(year + 1, 0, 1, timeZone), precision: 'year' };
  }

  if (str === 'last hour' || str === 'next hour') {
    const end = new Date(referenceDate);
    const start = new Date(end);
    if (str === 'last hour') start.setUTCHours(start.getUTCHours() - 1);
    else end.setUTCHours(end.getUTCHours() + 1);
    return { start, end, precision: 'hour' };
  }

  return null;
}

function shiftUtcMonth(date: Date, amount: number): void {
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + amount);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
}

function shiftUtcYear(date: Date, amount: number): void {
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() + amount);
  date.setUTCMonth(month);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
}

/**
 * Calculate date offset (e.g., "3 days ago")
 */
function calculateDateOffset(
  referenceDate: Date,
  amount: number,
  unit: string,
  fullText: string
): Date | null {
  const date = new Date(referenceDate);
  const isNegative = fullText.includes('ago') || fullText.includes('past');
  const multiplier = isNegative ? -1 : 1;

  const unitLower = unit.replace(/s$/, '').toLowerCase();

  switch (unitLower) {
    case 'day':
      date.setUTCDate(date.getUTCDate() + multiplier * amount);
      break;
    case 'week':
      date.setUTCDate(date.getUTCDate() + multiplier * amount * 7);
      break;
    case 'month':
      shiftUtcMonth(date, multiplier * amount);
      break;
    case 'year':
      shiftUtcYear(date, multiplier * amount);
      break;
    case 'hour':
      date.setUTCHours(date.getUTCHours() + multiplier * amount);
      break;
    case 'minute':
      date.setUTCMinutes(date.getUTCMinutes() + multiplier * amount);
      break;
    case 'second':
      date.setUTCSeconds(date.getUTCSeconds() + multiplier * amount);
      break;
    default:
      return null;
  }

  return date;
}

function calculateOffsetRange(
  referenceDate: Date,
  amount: number,
  unit: string,
  fullText: string,
  timeZone = 'UTC',
): TemporalFact['parsed'] | null {
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const normalizedUnit = unit.replace(/s$/, '').toLowerCase();
  const date = ['year', 'month', 'week', 'day'].includes(normalizedUnit)
    ? calculateLocalCalendarOffset(referenceDate, amount, normalizedUnit, fullText, timeZone)
    : calculateDateOffset(referenceDate, amount, unit, fullText);
  if (!date || Number.isNaN(date.getTime())) return null;

  if (['year', 'month', 'week', 'day'].includes(normalizedUnit)) {
    // Numeric offsets resolve relative to the supplied instant; retain its clock time.
    return { start: date, end: date, precision: 'day' };
  }
  if (normalizedUnit === 'hour') {
    const start = new Date(date);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start);
    end.setUTCHours(end.getUTCHours() + 1);
    return { start, end, precision: 'hour' };
  }
  if (normalizedUnit === 'minute') {
    const start = new Date(date);
    start.setUTCSeconds(0, 0);
    const end = new Date(start);
    end.setUTCMinutes(end.getUTCMinutes() + 1);
    return { start, end, precision: 'minute' };
  }
  if (normalizedUnit === 'second') {
    const start = new Date(date);
    start.setUTCMilliseconds(0);
    const end = new Date(start);
    end.setUTCSeconds(end.getUTCSeconds() + 1);
    return { start, end, precision: 'second' };
  }
  return null;
}

function calculateLocalCalendarOffset(referenceDate: Date, amount: number, unit: string, fullText: string, timeZone: string): Date {
  const local = localDateParts(referenceDate, timeZone);
  const civilDate = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second));
  const multiplier = fullText.includes('ago') || fullText.includes('past') ? -1 : 1;
  switch (unit) {
    case 'day': civilDate.setUTCDate(civilDate.getUTCDate() + multiplier * amount); break;
    case 'week': civilDate.setUTCDate(civilDate.getUTCDate() + multiplier * amount * 7); break;
    case 'month': shiftUtcMonth(civilDate, multiplier * amount); break;
    case 'year': shiftUtcYear(civilDate, multiplier * amount); break;
  }
  const result = localDateTimeToUtc({ year: civilDate.getUTCFullYear(), month: civilDate.getUTCMonth() + 1,
    day: civilDate.getUTCDate(), hour: civilDate.getUTCHours(), minute: civilDate.getUTCMinutes(),
    second: civilDate.getUTCSeconds() }, timeZone);
  result.setUTCMilliseconds(referenceDate.getUTCMilliseconds());
  return result;
}

/**
 * Calculate duration in milliseconds
 */
function calculateDurationMs(amount: number, unit: string): number {
  const unitLower = unit.replace(/s$/, '').toLowerCase();

  switch (unitLower) {
    case 'day':
      return amount * 24 * 60 * 60 * 1000;
    case 'week':
      return amount * 7 * 24 * 60 * 60 * 1000;
    case 'month':
      return amount * 30 * 24 * 60 * 60 * 1000;
    case 'year':
      return amount * 365 * 24 * 60 * 60 * 1000;
    case 'hour':
      return amount * 60 * 60 * 1000;
    case 'minute':
      return amount * 60 * 1000;
    case 'second':
      return amount * 1000;
    default:
      return 0;
  }
}

/**
 * Extract surrounding context for temporal expression
 */
function extractContext(content: string, index: number, contextLength: number = 50): string {
  const start = Math.max(0, index - contextLength);
  const end = Math.min(content.length, index + contextLength);
  return content.substring(start, end).trim();
}

/**
 * Simple content similarity calculation (token overlap)
 */
function calculateContentSimilarity(content1: string, content2: string): number {
  const tokens1 = new Set(content1.toLowerCase().split(/\s+/));
  const tokens2 = new Set(content2.toLowerCase().split(/\s+/));

  let overlap = 0;
  for (const token of tokens1) {
    if (tokens2.has(token)) overlap++;
  }

  const totalUnique = tokens1.size + tokens2.size - overlap;
  return totalUnique > 0 ? overlap / totalUnique : 0;
}
