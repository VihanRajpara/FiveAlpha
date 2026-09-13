// Self-check for the conditions filter — `node scripts/check-rules.mjs`.
//
// Rules are ANDed and applied to whatever the rest of the bar has already cut,
// so every way this can be wrong shows up as a table with the wrong rows in it
// and no error anywhere:
//
//   1. A half-typed operand filtering. The inputs hold strings, and a number
//      typed one digit at a time passes through '' and '-'. If those count as
//      0, the table empties between keystrokes and the filter reads as broken.
//   2. A row with no figure being admitted. An unmeasured row is not a match —
//      the same rule matchesBands and matchesSignalFilter already use — and
//      that has to hold for "the chart has not been read yet" as well.
//   3. `between` rejecting a range typed the other way round, and `is not`
//      quietly admitting rows whose value nobody knows.
//
// Bundled through esbuild (already a vite dependency) because Node cannot
// import TypeScript — same as scripts/check-chart.mjs.
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TMP = 'scripts/.check-rules.bundle.mjs';
await build({
  entryPoints: ['src/lib/rules.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: TMP,
});

let mod;
try {
  mod = await import(pathToFileURL(TMP).href);
} finally {
  await rm(TMP, { force: true });
}
const { matchesRules, rulesNeedSignals, newRule, retarget, describeRule, ruleIsLive, RULE_FIELDS } =
  mod;

/** A row as the table holds one — only the fields the rules read. */
const row = (symbol, price, chgPct, rsi) => ({
  symbol,
  ticker: `${symbol}.NS`,
  name: symbol,
  quote: { price, changePercent: chgPct, monthlyRsi14: rsi },
});

const sig = (side, age, price, score, trend = 1) => ({
  side,
  price,
  date: '2026-09-01',
  age,
  stop: price * 0.95,
  trend,
  volumeRatio: 2,
  turnover: 5e7,
  history: null,
  provisional: false,
  score,
});

const A = row('A', 110, 3, 65); //  BUY 12 sessions ago at 100 → gap +10%
const B = row('B', 90, -1, 45); //  BUY 2 sessions ago at 100 → gap −10%
const C = row('C', 200, 6, 80); //  SELL, and against the trend
const D = row('D', 50, 1, null); // priced, but no RSI and no reading at all
const rows = [A, B, C, D];

const readings = {
  'A.NS': { signal: sig('BUY', 12, 100, 70), mapo: { above: 85, proximity: 50 } },
  'B.NS': { signal: sig('BUY', 2, 100, 40), mapo: { above: 15, proximity: 50 } },
  'C.NS': { signal: sig('SELL', 30, 250, 55, -1), mapo: { above: 50, proximity: 50 } },
};
const read = (ticker) => readings[ticker];

const rule = (field, op, value, value2) => ({ id: `${field}-${op}`, field, op, value, value2 });
const pass = (rules) => rows.filter((r) => matchesRules(r, rules, read)).map((r) => r.symbol);

// --- 1. one rule, then several, ANDed ---------------------------------------
assert.deepEqual(pass([rule('price', 'gte', '100')]), ['A', 'C']);
assert.deepEqual(
  pass([rule('price', 'gte', '100'), rule('dayMove', 'gte', '5')]),
  ['C'],
  'rules narrow each other rather than replacing each other',
);
assert.deepEqual(pass([]), ['A', 'B', 'C', 'D'], 'no rules filters nothing');

// --- 2. a rule still being typed must not filter -----------------------------
assert.deepEqual(pass([rule('price', 'gte', '')]), ['A', 'B', 'C', 'D'], "'' is not 0");
assert.deepEqual(pass([rule('price', 'gte', '-')]), ['A', 'B', 'C', 'D']);
assert.deepEqual(
  pass([rule('price', 'between', '100')]),
  ['A', 'B', 'C', 'D'],
  'between with only one bound typed is not yet a rule',
);
assert.equal(ruleIsLive(rule('price', 'gte', '')), false);
assert.equal(ruleIsLive(rule('price', 'gte', '100')), true);

// --- 3. a row with no figure fails, it does not pass -------------------------
assert.deepEqual(pass([rule('rsi', 'gte', '0')]), ['A', 'B', 'C'], 'D has no RSI');
assert.deepEqual(pass([rule('sigScore', 'gte', '0')]), ['A', 'B', 'C'], 'D has no reading');

// --- 4. between, typed either way round --------------------------------------
assert.deepEqual(pass([rule('price', 'between', '80', '120')]), ['A', 'B']);
assert.deepEqual(
  pass([rule('price', 'between', '120', '80')]),
  ['A', 'B'],
  'the bounds are a range, not an order',
);
// Inclusive at both ends — a screener asked for "between 90 and 110" means it.
assert.deepEqual(pass([rule('price', 'between', '90', '110')]), ['A', 'B']);

// --- 5. list fields, and what "is not" does with an unknown ------------------
assert.deepEqual(pass([rule('sigSide', 'is', 'BUY')]), ['A', 'B']);
assert.deepEqual(
  pass([rule('sigSide', 'isnot', 'BUY')]),
  ['C'],
  'D has no reading, so it is not "not BUY" — it is unknown',
);
assert.deepEqual(pass([rule('sigTrend', 'is', 'against')]), ['C']);

// --- 6. signal-derived numbers ------------------------------------------------
assert.deepEqual(pass([rule('sigGap', 'gte', '0')]), ['A'], 'B is below its signal, C far below');
assert.deepEqual(pass([rule('sigAge', 'lte', '5')]), ['B']);
assert.deepEqual(pass([rule('mapo', 'gte', '80')]), ['A']);

// --- 7. which rules cost a chart read ----------------------------------------
assert.equal(rulesNeedSignals([rule('price', 'gte', '100')]), false);
assert.equal(rulesNeedSignals([rule('sigGap', 'gte', '5')]), true);
assert.equal(
  rulesNeedSignals([rule('sigGap', 'gte', '')]),
  false,
  'an unfinished rule filters nothing, so it must not start thousands of requests',
);

// --- 8. changing a rule's field cannot leave an impossible operand ------------
const numeric = newRule('price');
const swapped = retarget(numeric, 'sigSide');
assert.equal(swapped.id, numeric.id, 'the row keeps its identity so React does not remount it');
assert.equal(swapped.field, 'sigSide');
assert.ok(['is', 'isnot'].includes(swapped.op), 'a list field cannot be compared with ≥');
assert.ok(
  RULE_FIELDS.find((f) => f.key === 'sigSide').options.some((o) => o.value === swapped.value),
  'and its operand has to be one of that list',
);
assert.equal(ruleIsLive(newRule('price')), true, 'a new rule is born complete, not blank');

// --- 9. what the chip says ----------------------------------------------------
// ₹ leads its figure, % sticks to it, everything else follows it.
assert.equal(describeRule(rule('sigGap', 'gte', '5')), 'Gap ≥ 5%');
assert.equal(describeRule(rule('price', 'between', '80', '120')), 'LTP between ₹80–120');
assert.equal(describeRule(rule('mcap', 'gte', '1000')), 'M.Cap ≥ 1000 Cr');
assert.equal(describeRule(rule('sigSide', 'isnot', 'SELL')), 'Signal side is not SELL');

// Every field must be matchable — a field in the picker with neither `get` nor
// `pick` is a condition that silently drops every row.
for (const f of RULE_FIELDS) {
  assert.ok(f.get || f.pick, `${f.key} has no accessor`);
  assert.ok(!f.options || f.pick, `${f.key} offers a list but cannot read one`);
  assert.ok(f.preset !== undefined, `${f.key} has no preset, so a new rule would be blank`);
}

console.log('rule filters ok');
