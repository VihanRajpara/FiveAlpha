import type { SecurityWithQuote } from '../types';
import { signalGapPct, stopDistancePct, type Reading } from './signals';

/**
 * Conditions the user writes, rather than presets the app offers.
 *
 * The bar's band filters answer the common questions in one click — "under
 * ₹100", "RSI over 70" — and cannot answer anything else. A screener is a tool
 * for the question nobody anticipated: gap between 4 and 9 percent, score over
 * 70, on a signal less than ten sessions old, all at once. That is three
 * conditions on three columns, and no set of presets covers it.
 *
 * So: a list of `(field, operator, operand)` rules, ANDed. Every rule is one
 * row of state and one line of matching, which is what keeps adding the
 * fifteenth field a data change rather than a code change — the same bet
 * `NUMERIC_FILTERS` makes, taken one step further.
 *
 * **AND only.** Every screener question that has come up here is a narrowing —
 * "and also" — and OR needs grouping and precedence to mean anything, which is
 * a query builder rather than a filter row. Two saved views beat one
 * parenthesised expression nobody can read back.
 *
 * Operands are kept as the strings the inputs hold, not as numbers. A rule
 * being typed is briefly `''` or `'-'`, and a half-written number must not
 * empty the table: an unparseable operand makes the rule inert (see
 * `matchesRules`), not false.
 */

export type Op = 'gte' | 'lte' | 'between' | 'is' | 'isnot';

export const OP_LABEL: Record<Op, string> = {
  gte: '≥',
  lte: '≤',
  between: 'between',
  is: 'is',
  isnot: 'is not',
};

/** Which operators a field offers. Numbers get three, lists get two. */
export const NUMERIC_OPS: Op[] = ['gte', 'lte', 'between'];
export const LIST_OPS: Op[] = ['is', 'isnot'];

export interface Rule {
  id: string;
  field: string;
  op: Op;
  /** The operand as typed, or the chosen option's value. */
  value: string;
  /** `between`'s upper bound. Ignored by every other operator. */
  value2?: string;
}

export interface RuleField {
  key: string;
  label: string;
  /** Which heading it sits under in the field picker. */
  group: 'Price' | 'Fundamentals' | 'Signal';
  /** Printed after the operand, so a chip reads "Gap ≥ 5%" rather than "Gap ≥ 5". */
  unit?: string;
  /** A number the row can be compared on. Set this or `pick`, never both. */
  get?: (row: SecurityWithQuote, reading: Reading | undefined) => number | null | undefined;
  /** A value the row can be matched against a fixed list. */
  pick?: (row: SecurityWithQuote, reading: Reading | undefined) => string | null | undefined;
  options?: { value: string; label: string }[];
  /**
   * True when answering it costs the symbol's chart.
   *
   * The caller reads this to decide whether adding the rule should start a
   * bulk read — see `rulesNeedSignals`. A rule on a field nothing has fetched
   * matches nothing, which looks exactly like a filter that is broken.
   */
  needsSignal?: boolean;
  /** What a new rule on this field starts at, so it is never born blank. */
  preset: number | string;
  /** Fractional digits the operand input steps by. */
  step?: number;
}

const sig = (reading: Reading | undefined) => reading?.signal ?? null;

/**
 * Every column the table shows a number for, plus the two the signal has that
 * no column does.
 *
 * Exchange, series, segment and cap are deliberately absent: the bar already
 * selects on all four, and a second place to say the same thing is a second
 * place for the two to disagree.
 */
export const RULE_FIELDS: RuleField[] = [
  {
    key: 'price',
    label: 'LTP',
    group: 'Price',
    unit: '₹',
    get: (row) => row.quote?.price,
    preset: 100,
  },
  {
    key: 'dayMove',
    label: 'Day move',
    group: 'Price',
    unit: '%',
    get: (row) => row.quote?.changePercent,
    preset: 2,
    step: 0.1,
  },
  {
    key: 'mcap',
    label: 'M.Cap',
    group: 'Price',
    unit: 'Cr',
    get: (row) => row.quote?.marketCapCr,
    preset: 1000,
  },
  {
    key: 'rsi',
    label: 'RSI(M)',
    group: 'Fundamentals',
    get: (row) => row.quote?.monthlyRsi14,
    preset: 60,
    step: 0.1,
  },
  {
    key: 'roce',
    label: 'ROCE',
    group: 'Fundamentals',
    unit: '%',
    get: (row) => row.quote?.rocePct,
    preset: 15,
    step: 0.1,
  },
  {
    key: 'sigSide',
    label: 'Signal side',
    group: 'Signal',
    needsSignal: true,
    pick: (_row, reading) => sig(reading)?.side,
    options: [
      { value: 'BUY', label: 'BUY' },
      { value: 'SELL', label: 'SELL' },
    ],
    preset: 'BUY',
  },
  {
    key: 'sigAge',
    label: 'Signal age',
    group: 'Signal',
    unit: 'sessions',
    needsSignal: true,
    get: (_row, reading) => sig(reading)?.age,
    preset: 10,
  },
  {
    key: 'sigAt',
    label: 'Signal price',
    group: 'Signal',
    unit: '₹',
    needsSignal: true,
    get: (_row, reading) => sig(reading)?.price,
    preset: 100,
  },
  {
    key: 'sigGap',
    label: 'Gap',
    group: 'Signal',
    unit: '%',
    needsSignal: true,
    get: (row, reading) => {
      const signal = sig(reading);
      return signal ? signalGapPct(signal, row.quote?.price) : null;
    },
    preset: 5,
    step: 0.1,
  },
  {
    key: 'sigStop',
    label: 'Stop room',
    group: 'Signal',
    unit: '%',
    needsSignal: true,
    get: (row, reading) => {
      const signal = sig(reading);
      return signal ? stopDistancePct(signal, row.quote?.price) : null;
    },
    preset: 3,
    step: 0.1,
  },
  {
    key: 'sigScore',
    label: 'Signal score',
    group: 'Signal',
    needsSignal: true,
    get: (_row, reading) => sig(reading)?.score,
    preset: 60,
  },
  {
    key: 'mapo',
    label: 'MAPO',
    group: 'Signal',
    needsSignal: true,
    // Present without a flip — see `Reading`. Kept out of `sig` for that reason.
    get: (_row, reading) => reading?.mapo?.above,
    preset: 80,
  },
  {
    key: 'sigTrend',
    label: 'Signal trend',
    group: 'Signal',
    needsSignal: true,
    pick: (_row, reading) => {
      const signal = sig(reading);
      if (!signal) return null;
      return signal.trend === 1 ? 'with' : signal.trend === -1 ? 'against' : 'flat';
    },
    options: [
      { value: 'with', label: 'With the trend' },
      { value: 'against', label: 'Against it' },
      { value: 'flat', label: 'No trend yet' },
    ],
    preset: 'with',
  },
  {
    key: 'sigVol',
    label: 'Flip volume',
    group: 'Signal',
    unit: '× avg',
    needsSignal: true,
    get: (_row, reading) => sig(reading)?.volumeRatio,
    preset: 1.5,
    step: 0.1,
  },
  {
    key: 'sigTurnover',
    label: 'Turnover',
    group: 'Signal',
    unit: '₹',
    needsSignal: true,
    get: (_row, reading) => sig(reading)?.turnover,
    preset: 10000000,
  },
];

const BY_KEY = new Map(RULE_FIELDS.map((f) => [f.key, f]));

export const ruleField = (key: string): RuleField | undefined => BY_KEY.get(key);

/** The operators a field accepts. A list field cannot be compared with `≥`. */
export const opsFor = (field: RuleField): Op[] => (field.options ? LIST_OPS : NUMERIC_OPS);

let seq = 0;

/** A rule on `field`, ready to match — never a blank row waiting to be filled. */
export function newRule(key: string): Rule {
  const field = BY_KEY.get(key) ?? RULE_FIELDS[0];
  return {
    id: `r${++seq}`,
    field: field.key,
    op: opsFor(field)[0],
    value: String(field.preset),
    value2: field.options ? undefined : String(Number(field.preset) * 2),
  };
}

/**
 * Moves a rule to another field without leaving an operand that field cannot use.
 *
 * Switching "Gap ≥ 5" to "Signal side" has to drop both the operator and the
 * operand: `≥ 5` on a two-value list is a rule that can never be true, and a
 * filter that silently matches nothing is worse than one that resets.
 */
export function retarget(rule: Rule, key: string): Rule {
  const next = newRule(key);
  return { ...next, id: rule.id };
}

/** `NaN` for anything the user has not finished typing. */
const operand = (raw: string | undefined): number => {
  const trimmed = (raw ?? '').trim();
  return trimmed === '' ? NaN : Number(trimmed);
};

/** Whether the rule is complete enough to exclude anything. */
export function ruleIsLive(rule: Rule): boolean {
  const field = BY_KEY.get(rule.field);
  if (!field) return false;
  if (field.options) return rule.value !== '';
  if (Number.isNaN(operand(rule.value))) return false;
  return rule.op !== 'between' || !Number.isNaN(operand(rule.value2));
}

/**
 * Does the row pass every live rule?
 *
 * A row with no figure for a live rule is rejected rather than admitted — the
 * same rule `matchesBands` and `matchesSignalFilter` use, and for the same
 * reason: filtering is asking for rows that say something, and a row with
 * nothing to say is not an answer. That covers "the chart has not been read
 * yet" too, which is why the bar narrates the read while it runs.
 *
 * An incomplete rule is skipped, not failed. Typing an operand one digit at a
 * time passes through `''` and `'-'`, and a table that blanks between
 * keystrokes reads as a filter that does not work.
 */
export function matchesRules(
  row: SecurityWithQuote,
  rules: Rule[],
  read: (ticker: string) => Reading | undefined,
): boolean {
  for (const rule of rules) {
    const field = BY_KEY.get(rule.field);
    if (!field || !ruleIsLive(rule)) continue;

    const reading = field.needsSignal ? read(row.ticker) : undefined;

    if (field.options) {
      const held = field.pick?.(row, reading);
      if (held === null || held === undefined) return false;
      if (rule.op === 'is' ? held !== rule.value : held === rule.value) return false;
      continue;
    }

    const value = field.get?.(row, reading);
    if (value === null || value === undefined || Number.isNaN(value)) return false;

    const a = operand(rule.value);
    if (rule.op === 'gte' && value < a) return false;
    if (rule.op === 'lte' && value > a) return false;
    if (rule.op === 'between') {
      // Typed either way round: "between 9 and 4" is the same request as
      // "between 4 and 9", and rejecting it teaches nothing.
      const b = operand(rule.value2);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (value < lo || value > hi) return false;
    }
  }
  return true;
}

/** Whether any live rule needs a chart read, so the caller can start one. */
export const rulesNeedSignals = (rules: Rule[]): boolean =>
  rules.some((r) => ruleIsLive(r) && BY_KEY.get(r.field)?.needsSignal === true);

/**
 * The operand with its unit attached, the way that unit is actually written.
 *
 * Three shapes, because ₹ leads its figure, % sticks to it and everything else
 * follows it with a space. Concatenating one way for all of them produced
 * "100 ₹" and "5 %", which is the kind of detail that makes a chip read as
 * generated rather than written.
 */
export function withUnit(field: RuleField, figure: string): string {
  if (field.unit === '₹') return `₹${figure}`;
  if (field.unit === '%') return `${figure}%`;
  return field.unit ? `${figure} ${field.unit}` : figure;
}

/** The rule as one line of text — the chip in the bar, and its tooltip. */
export function describeRule(rule: Rule): string {
  const field = BY_KEY.get(rule.field);
  if (!field) return '';

  if (field.options) {
    const label = field.options.find((o) => o.value === rule.value)?.label ?? rule.value;
    return `${field.label} ${OP_LABEL[rule.op]} ${label}`;
  }
  if (rule.op === 'between') {
    return `${field.label} ${OP_LABEL.between} ${withUnit(field, `${rule.value}–${rule.value2}`)}`;
  }
  return `${field.label} ${OP_LABEL[rule.op]} ${withUnit(field, rule.value)}`;
}
