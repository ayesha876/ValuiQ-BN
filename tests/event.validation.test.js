/**
 * event.validation.test.js — Zod-layer unit tests for Row 3 (feedFormat + rounds),
 * plus regression guards for the pre-existing event validation behaviour.
 *
 * No DB: these exercise the schemas as pure functions. The segmented GO-LIVE rule
 * (>= 1 round, each shortlistSize >= 1) is deliberately NOT tested here — it lives in
 * event.service.js beside assertGoLiveReady, so at the Zod layer a segmented payload
 * with zero rounds must still PARSE (asserted below).
 */
import { describe, it, expect } from 'vitest';
import validation from '../src/modules/events/event.validation.js';

const { createEventSchema, updateEventSchema } = validation;

const validRound = {
  segment: { type: 'hotlist', timeLimit: 10, submissionLimit: 50 },
  pricing: { minPostCost: 10, minVoteCost: 5 },
  neglectTimer: 30,
  shortlistSize: 10,
};

describe('Row 3 — feedFormat + rounds (create schema, new behaviour)', () => {
  it('accepts open format with no rounds', () => {
    const r = createEventSchema.safeParse({ name: 'Event', feedFormat: 'open' });
    expect(r.success).toBe(true);
    expect(r.data.rounds).toBeUndefined();
  });

  it('accepts segmented format with valid nested rounds and preserves the shape', () => {
    const r = createEventSchema.safeParse({
      name: 'Event',
      feedFormat: 'segmented',
      rounds: [validRound],
    });
    expect(r.success).toBe(true);
    expect(r.data.rounds[0].segment.submissionLimit).toBe(50);
    expect(r.data.rounds[0].pricing.minVoteCost).toBe(5);
    expect(r.data.rounds[0].shortlistSize).toBe(10);
  });

  it('coerces numeric strings inside a round (0 preserved)', () => {
    const r = createEventSchema.safeParse({
      name: 'Event',
      feedFormat: 'segmented',
      rounds: [{ segment: { timeLimit: '0' }, pricing: { minPostCost: '0' }, shortlistSize: '3' }],
    });
    expect(r.success).toBe(true);
    expect(r.data.rounds[0].segment.timeLimit).toBe(0);
    expect(r.data.rounds[0].pricing.minPostCost).toBe(0);
    expect(r.data.rounds[0].shortlistSize).toBe(3);
  });

  it('rejects more than 10 rounds (array cap)', () => {
    const rounds = Array.from({ length: 11 }, () => ({ shortlistSize: 1 }));
    const r = createEventSchema.safeParse({ name: 'Event', feedFormat: 'segmented', rounds });
    expect(r.success).toBe(false);
  });

  it('rejects a bad feedFormat enum', () => {
    const r = createEventSchema.safeParse({ name: 'Event', feedFormat: 'weird' });
    expect(r.success).toBe(false);
  });

  it('rejects a bad round segment.type enum', () => {
    const r = createEventSchema.safeParse({
      name: 'Event',
      feedFormat: 'segmented',
      rounds: [{ segment: { type: 'nope' } }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects a negative int inside a round', () => {
    const r = createEventSchema.safeParse({
      name: 'Event',
      feedFormat: 'segmented',
      rounds: [{ shortlistSize: -1 }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown key inside a round (.strict blocks an echoed id)', () => {
    const r = createEventSchema.safeParse({
      name: 'Event',
      feedFormat: 'segmented',
      rounds: [{ id: '507f1f77bcf86cd799439011', shortlistSize: 1 }],
    });
    expect(r.success).toBe(false);
  });

  it('LAYERING: segmented + intent:live + zero rounds still PARSES (rule is service-side)', () => {
    const r = createEventSchema.safeParse({ name: 'Event', feedFormat: 'segmented', intent: 'live' });
    expect(r.success).toBe(true);
  });
});

describe('Row 3 — update schema accepts the new fields', () => {
  it('accepts rounds on PATCH (whole-array replace)', () => {
    const r = updateEventSchema.safeParse({ rounds: [validRound] });
    expect(r.success).toBe(true);
  });

  it('accepts an explicit empty rounds array on PATCH (segmented -> open clear)', () => {
    const r = updateEventSchema.safeParse({ feedFormat: 'open', rounds: [] });
    expect(r.success).toBe(true);
    expect(r.data.rounds).toEqual([]);
  });
});

describe('Regression — pre-existing behaviour unchanged', () => {
  it('accepts a legacy payload with no feedFormat/rounds (backward compat)', () => {
    const r = createEventSchema.safeParse({
      name: 'Legacy',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      segment: { type: 'instant', timeLimit: 5, submissionLimit: 20 },
      pricing: { minPostCost: 1, minVoteCost: 1 },
    });
    expect(r.success).toBe(true);
  });

  it('still rejects an unknown top-level key (mass-assignment guard)', () => {
    const r = createEventSchema.safeParse({ name: 'Event', owner: 'x', status: 'live' });
    expect(r.success).toBe(false);
  });

  it('slug is still create-only — update rejects it (.strict keeps the link fixed)', () => {
    expect(createEventSchema.safeParse({ name: 'Event', slug: 'my-event' }).success).toBe(true);
    expect(updateEventSchema.safeParse({ slug: 'my-event' }).success).toBe(false);
  });

  it('endAfterStart refine still fires', () => {
    const r = createEventSchema.safeParse({
      name: 'Event',
      startDate: '2026-02-02',
      endDate: '2026-01-01',
    });
    expect(r.success).toBe(false);
  });

  it('still rejects a negative opening-segment cost', () => {
    const r = createEventSchema.safeParse({ name: 'Event', pricing: { minPostCost: -1 } });
    expect(r.success).toBe(false);
  });
});
