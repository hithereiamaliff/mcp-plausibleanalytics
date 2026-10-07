import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { V2QueryResponse } from '../src/plausible/client.js';
import {
  describePeriod,
  formatDuration,
  formatMetricValue,
  hintForError,
  markdownTable,
  metaNotes,
  toRows,
  zeroFillTimeseries,
} from '../src/plausible/format.js';
import { PlausibleApiError } from '../src/plausible/http.js';
import type { InstanceProfile } from '../src/plausible/profile.js';

const response = (results: V2QueryResponse['results'], meta: V2QueryResponse['meta'] = {}): V2QueryResponse => ({
  results,
  meta,
  query: { site_id: 'example.com', metrics: [], date_range: ['2026-10-01T00:00:00+00:00', '2026-10-07T23:59:59+00:00'] },
});

describe('rows', () => {
  it('names positional results', () => {
    const rows = toRows(response([{ dimensions: ['Malaysia'], metrics: [10, 45] }]), ['visit:country_name'], ['visitors', 'bounce_rate']);
    assert.deepEqual(rows, [{ country: 'Malaysia', visitors: 10, bounce_rate: 45 }]);
  });

  it('zero-fills empty time buckets', () => {
    const rows = [{ 'time:day': '2026-10-02', visitors: 5 }];
    assert.deepEqual(zeroFillTimeseries(rows, ['2026-10-01', '2026-10-02', '2026-10-03'], 'time:day', ['visitors']), [
      { 'time:day': '2026-10-01', visitors: 0 },
      { 'time:day': '2026-10-02', visitors: 5 },
      { 'time:day': '2026-10-03', visitors: 0 },
    ]);
  });
});

describe('values', () => {
  it('formats metrics by kind', () => {
    assert.equal(formatMetricValue('visitors', 12345), '12,345');
    assert.equal(formatMetricValue('bounce_rate', 41), '41%');
    assert.equal(formatMetricValue('visit_duration', 83), '1m 23s');
    assert.equal(formatMetricValue('views_per_visit', 2.456), '2.46');
    assert.equal(formatMetricValue('total_revenue', { short: '$1.2K', value: 1200 }), '$1.2K');
    assert.equal(formatMetricValue('visitors', null), '—');
    assert.equal(formatDuration(3725), '1h 2m');
  });

  it('renders escaped markdown tables', () => {
    const table = markdownTable(['page', 'visitors'], [{ page: '/a|b', visitors: 3 }, { page: '', visitors: 1 }], ['visitors']);
    assert.match(table, /\| page \| visitors \|/);
    assert.match(table, /\| --- \| ---: \|/);
    assert.match(table, /\/a\\\|b/);
    assert.match(table, /\(none\)/);
    assert.equal(markdownTable(['a'], [], []), '_No data for this period._');
  });

  it('describes periods compactly', () => {
    assert.equal(describePeriod(['2026-10-01T00:00:00+08:00', '2026-10-07T23:59:59+08:00']), '2026-10-01 → 2026-10-07');
    assert.equal(describePeriod(['2026-10-08T00:00:00+08:00', '2026-10-08T23:59:59+08:00']), '2026-10-08');
  });

  it('adds pagination and import notes', () => {
    const notes = metaNotes(response([], { total_rows: 50, imports_warning: 'partial' }), 10);
    assert.ok(notes.some(note => note.includes('offset=10')));
    assert.ok(notes.some(note => note.includes('partial')));
  });
});

describe('hintForError', () => {
  const ce = { edition: 'community', versionNumber: [2, 1, 5], version: 'v2.1.5' } as InstanceProfile;

  it('explains common failures', () => {
    assert.match(hintForError(new PlausibleApiError(401, 'Invalid API key', 'POST /api/v2/query'))!, /team/);
    assert.match(hintForError(new PlausibleApiError(401, 'nope', 'GET /api/plugins/v1/goals'))!, /Plugin Token/i);
    assert.match(hintForError(new PlausibleApiError(404, 'Not Found', 'GET /api/v1/sites'))!, /Community Edition/);
    assert.match(hintForError(new PlausibleApiError(400, 'Metric `views_per_visit` cannot be queried with `dimensions`', 'POST /api/v2/query'))!, /views_per_visit/);
    assert.match(hintForError(new PlausibleApiError(400, '#/date_range: Invalid date range "28d"', 'POST /api/v2/query'), ce)!, /CE 3\.0\+/);
    assert.match(hintForError(new PlausibleApiError(0, 'timed out', 'POST /api/v2/query'))!, /reach/);
  });
});
