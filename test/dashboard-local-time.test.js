'use strict';

/**
 * Dashboard timestamps render in the viewer's local zone with a short zone
 * label, never as raw UTC (the Recent list used to show "2026-11-24 19:37:01"
 * for 2:37 PM Eastern).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ui = require('../templates/dashboard/dashboard.js');

const AT = '2026-11-24T19:37:01.000Z';

describe('formatLocalDateTime', () => {
  it('converts UTC ISO to the given zone with a short label', () => {
    assert.equal(ui.formatLocalDateTime(AT, { timeZone: 'America/New_York' }), '2026-11-24 14:37:01 EST');
    assert.equal(ui.formatLocalDateTime('2026-06-15T00:52:17.000Z', { timeZone: 'America/New_York' }), '2026-06-14 20:52:17 EDT');
    assert.equal(ui.formatLocalDateTime(AT, { timeZone: 'America/Los_Angeles' }), '2026-11-24 11:37:01 PST');
    assert.equal(ui.formatLocalDateTime(AT, { timeZone: 'UTC' }), '2026-11-24 19:37:01 UTC');
  });

  it('uses the runtime (browser) zone by default', () => {
    const d = new Date(AT);
    const pad = (n) => String(n).padStart(2, '0');
    const expect = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const out = ui.formatLocalDateTime(AT);
    assert.ok(out.startsWith(expect + ' '), `${out} starts with ${expect}`);
    assert.match(out, / \S+$/, 'has a zone label');
  });

  it('midnight is 00, not 24; epoch ms and options work; junk passes through', () => {
    assert.equal(ui.formatLocalDateTime('2026-11-25T05:00:00.000Z', { timeZone: 'America/New_York' }), '2026-11-25 00:00:00 EST');
    assert.equal(ui.formatLocalDateTime(Date.parse(AT), { timeZone: 'America/New_York', seconds: false, zone: false }), '2026-11-24 14:37');
    assert.equal(ui.formatLocalDateTime(null), '');
    assert.equal(ui.formatLocalDateTime(''), '');
    assert.equal(ui.formatLocalDateTime('not a time'), 'not a time');
  });

  it('Loops detail shows Started / Updated in local time', () => {
    const html = ui.renderLoopDetailHtml({ name: 'demo', status: 'completed', startedAt: AT, updatedAt: AT, pipeline: [] });
    const local = ui.formatLocalDateTime(AT);
    assert.ok(html.includes('<span class="k">Started</span><span class="v">' + local + '</span>'));
    assert.ok(html.includes('<span class="k">Updated</span><span class="v">' + local + '</span>'));
    assert.ok(!html.includes('19:37:01 ') || local.startsWith('2026-11-24 19:37:01'), 'no raw UTC');
  });

  it('task completion stamp is local', () => {
    const html = ui.renderTaskCompletion({ sessionTitle: 's', at: AT, summary: 'done' });
    assert.ok(html.includes(ui.formatLocalDateTime(AT)));
  });

  it('no client code slices raw ISO strings for display', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'templates', 'dashboard', 'dashboard.js'), 'utf8');
    assert.doesNotMatch(src, /\.replace\('T', ' '\)/, 'Recent / History must use formatLocalDateTime');
  });

  it('making-of page formats times in the viewer zone (no fixed America/New_York)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'making-of', 'view.html'), 'utf8');
    assert.doesNotMatch(html, /America\/New_York/);
    assert.doesNotMatch(html, /\+' ET'/);
    assert.match(html, /timeZoneName:'short'/);
  });
});
