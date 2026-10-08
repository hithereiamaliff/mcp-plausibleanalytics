import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ToolInputError,
  buildFilters,
  comparisonRange,
  compatibleMetrics,
  computeChange,
  dimensionLabel,
  offsetOf,
  resolveDateRange,
  resolveDimension,
  withOffsets,
} from '../src/plausible/query-helpers.js';

describe('resolveDimension', () => {
  it('maps aliases, props and full names', () => {
    assert.equal(resolveDimension('page'), 'event:page');
    assert.equal(resolveDimension('Country'), 'visit:country_name');
    assert.equal(resolveDimension('utm_campaign'), 'visit:utm_campaign');
    assert.equal(resolveDimension('prop:author'), 'event:props:author');
    assert.equal(resolveDimension('event:props:plan'), 'event:props:plan');
    assert.equal(resolveDimension('visit:browser_version'), 'visit:browser_version');
    assert.equal(resolveDimension('time:day'), 'time:day');
  });

  it('rejects unknown dimensions with guidance', () => {
    assert.throws(() => resolveDimension('pages'), (error: unknown) => error instanceof ToolInputError && /Aliases/.test(error.message));
  });

  it('does not resolve Object.prototype members', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.throws(() => resolveDimension(name), ToolInputError, name);
    }
    assert.throws(() => resolveDateRange('constructor'), ToolInputError);
  });

  it('labels dimensions with their short alias', () => {
    assert.equal(dimensionLabel('visit:country_name'), 'country');
    assert.equal(dimensionLabel('event:props:author'), 'prop:author');
    assert.equal(dimensionLabel('time:day'), 'time:day');
  });
});

describe('buildFilters', () => {
  it('builds v2 filter tuples', () => {
    assert.deepEqual(
      buildFilters([
        { dimension: 'country', values: ['Malaysia'] },
        { dimension: 'page', operator: 'contains', values: ['/blog'], case_sensitive: false },
      ]),
      [
        ['is', 'visit:country_name', ['Malaysia']],
        ['contains', 'event:page', ['/blog'], { case_sensitive: false }],
      ],
    );
  });

  it('enforces Plausible filter rules', () => {
    assert.throws(() => buildFilters([{ dimension: 'goal', operator: 'is_not', values: ['Signup'] }]), ToolInputError);
    assert.throws(() => buildFilters([{ dimension: 'page', operator: 'matches', values: ['^/a'], case_sensitive: false }]), ToolInputError);
    assert.throws(() => buildFilters([{ dimension: 'time:day', values: ['2026-01-01'] }]), ToolInputError);
    assert.throws(() => buildFilters([{ dimension: 'page', values: [] }]), ToolInputError);
  });
});

describe('resolveDateRange', () => {
  it('accepts shorthands and aliases', () => {
    assert.equal(resolveDateRange(undefined), '30d');
    assert.equal(resolveDateRange('7D'), '7d');
    assert.equal(resolveDateRange('today'), 'day');
    assert.equal(resolveDateRange('3mo'), '3mo');
    assert.equal(resolveDateRange('24h'), '24h');
  });

  it('accepts custom date and datetime ranges', () => {
    assert.deepEqual(resolveDateRange({ from: '2026-01-01', to: '2026-01-31' }), ['2026-01-01', '2026-01-31']);
    assert.deepEqual(resolveDateRange(['2026-01-01T09:00+08:00', '2026-01-01T17:00+08:00']), [
      '2026-01-01T09:00:00+08:00',
      '2026-01-01T17:00:00+08:00',
    ]);
  });

  it('rejects invalid ranges', () => {
    assert.throws(() => resolveDateRange('last week'), ToolInputError);
    assert.throws(() => resolveDateRange('realtime'), /get_realtime_visitors/);
    assert.throws(() => resolveDateRange({ from: '2026-02-01', to: '2026-01-01' }), ToolInputError);
    assert.throws(() => resolveDateRange({ from: '2026-01-01', to: '2026-01-31T00:00:00Z' }), ToolInputError);
  });
});

describe('comparisonRange', () => {
  const day = (start: string, end: string): [string, string] => [`${start}T00:00:00+08:00`, `${end}T23:59:59+08:00`];

  it('shifts day-based ranges by their length', () => {
    assert.deepEqual(comparisonRange(day('2026-10-01', '2026-10-07'), 'previous_period', '7d'), ['2026-09-24', '2026-09-30']);
    assert.deepEqual(comparisonRange(day('2026-09-08', '2026-10-07'), 'previous_period', '30d'), ['2026-08-09', '2026-09-07']);
  });

  it('aligns whole months', () => {
    assert.deepEqual(comparisonRange(day('2026-10-01', '2026-10-31'), 'previous_period', 'month'), ['2026-09-01', '2026-09-30']);
    assert.deepEqual(comparisonRange(day('2026-03-01', '2026-03-31'), 'previous_period', 'month'), ['2026-02-01', '2026-02-28']);
    assert.deepEqual(comparisonRange(day('2026-04-01', '2026-09-30'), 'previous_period', '6mo'), ['2025-10-01', '2026-03-31']);
    assert.deepEqual(comparisonRange(day('2026-01-01', '2026-01-31'), 'previous_period', ['2026-01-01', '2026-01-31']), ['2025-12-01', '2025-12-31']);
  });

  it('compares trimmed month-to-date with the same days last month', () => {
    assert.deepEqual(
      comparisonRange(['2026-10-01T00:00:00+08:00', '2026-10-08T14:30:00+08:00'], 'previous_period', 'month'),
      ['2026-09-01T00:00:00+08:00', '2026-09-08T14:30:00+08:00'],
    );
  });

  it('shifts today to yesterday', () => {
    assert.deepEqual(comparisonRange(day('2026-10-08', '2026-10-08'), 'previous_period', 'day'), ['2026-10-07', '2026-10-07']);
  });

  it('handles year over year, including leap days', () => {
    assert.deepEqual(comparisonRange(day('2026-10-01', '2026-10-31'), 'year_over_year', 'month'), ['2025-10-01', '2025-10-31']);
    assert.deepEqual(comparisonRange(day('2028-02-01', '2028-02-29'), 'year_over_year', 'month'), ['2027-02-01', '2027-02-28']);
  });

  it('uses exact durations for partial-day custom ranges and 24h', () => {
    assert.deepEqual(
      comparisonRange(['2026-10-08T09:00:00+08:00', '2026-10-08T11:59:59+08:00'], 'previous_period', ['2026-10-08T09:00:00+08:00', '2026-10-08T11:59:59+08:00']),
      ['2026-10-08T06:00:00+08:00', '2026-10-08T08:59:59+08:00'],
    );
  });

  it('returns undefined for "all"', () => {
    assert.equal(comparisonRange(day('2020-01-01', '2026-10-08'), 'previous_period', 'all'), undefined);
  });
});

describe('compatibleMetrics', () => {
  it('mirrors Plausible\'s session/event conflict rule', () => {
    assert.deepEqual(compatibleMetrics(['visitors', 'pageviews', 'bounce_rate'], ['event:page']), ['visitors', 'pageviews', 'bounce_rate']);
    assert.deepEqual(compatibleMetrics(['visitors', 'pageviews', 'bounce_rate'], ['event:hostname']), ['visitors', 'pageviews']);
    assert.deepEqual(compatibleMetrics(['visitors', 'pageviews'], ['time:day', 'visit:entry_page']), ['visitors']);
    assert.deepEqual(compatibleMetrics(['visitors', 'events', 'conversion_rate'], ['event:goal', 'visit:exit_page']), ['visitors', 'conversion_rate']);
    assert.deepEqual(compatibleMetrics(['visitors', 'total_revenue'], ['visit:entry_page']), ['visitors']);
    assert.deepEqual(compatibleMetrics(['bounce_rate'], ['event:goal']), ['visitors']);
    assert.deepEqual(compatibleMetrics(['visitors', 'bounce_rate', 'visit_duration'], ['visit:source']), ['visitors', 'bounce_rate', 'visit_duration']);
  });
});

describe('offsets', () => {
  it('reads and replaces datetime offsets', () => {
    assert.equal(offsetOf('2026-10-01T00:00:00+02:00'), '+02:00');
    assert.equal(offsetOf('2026-10-01T00:00:00Z'), 'Z');
    assert.equal(offsetOf('2026-10-01'), undefined);
    assert.deepEqual(
      withOffsets(['2026-10-01T00:00:00+01:00', '2026-10-08T14:30:00+01:00'], '+02:00', '+02:00'),
      ['2026-10-01T00:00:00+02:00', '2026-10-08T14:30:00+02:00'],
    );
    assert.deepEqual(withOffsets(['2026-10-01T00:00:00+01:00', '2026-10-08T14:30:00+01:00'], 'Z', undefined), [
      '2026-10-01T00:00:00+00:00',
      '2026-10-08T14:30:00+01:00',
    ]);
  });
});

describe('computeChange', () => {
  it('uses percent for counts and percentage points for rates', () => {
    assert.deepEqual(computeChange('visitors', 120, 100), { value: 20, unit: '%' });
    assert.deepEqual(computeChange('visitors', 50, 200), { value: -75, unit: '%' });
    assert.deepEqual(computeChange('bounce_rate', 42, 50), { value: -8, unit: 'pp' });
    assert.deepEqual(computeChange('visitors', 10, 0), { value: null, unit: '%' });
    assert.deepEqual(computeChange('total_revenue', { value: 150 }, { value: 100 }), { value: 50, unit: '%' });
  });
});
