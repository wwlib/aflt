'use strict';

/**
 * Render a making-of payload (lib/making-of.js collectLoop) as one
 * self-contained HTML page: viewer + data inline, no network needed.
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'making-of', 'view.html');
const PLACEHOLDER = '/*__MAKING_OF_DATA__*/';

/** JSON safe inside <script type="application/json">. */
function embedJson(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderHtml(data) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  const idx = tpl.indexOf(PLACEHOLDER);
  if (idx === -1) throw new Error(`making-of template is missing ${PLACEHOLDER}`);
  return tpl.slice(0, idx) + embedJson(data) + tpl.slice(idx + PLACEHOLDER.length);
}

module.exports = { TEMPLATE, PLACEHOLDER, embedJson, renderHtml };
