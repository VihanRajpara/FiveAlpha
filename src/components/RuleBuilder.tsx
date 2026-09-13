import { SelectMenu } from './SelectMenu';
import {
  newRule,
  opsFor,
  OP_LABEL,
  retarget,
  ruleField,
  RULE_FIELDS,
  type Rule,
} from '../lib/rules';

/**
 * The conditions editor: one row per rule, ANDed, added and removed by hand.
 *
 * It sits under the band filters in the same sheet rather than in a surface of
 * its own, because it is the same question asked more precisely — the bands are
 * the four answers people want most, this is the one they wanted instead. A
 * separate "advanced" panel would make the two look like different features and
 * leave the reader to discover that the bands are the shortcut.
 *
 * Every control here is the app's own `SelectMenu` rather than a native
 * `<select>`: the popup of a native one is drawn by the OS and ignores the
 * theme, which inside a dark sheet is a white rectangle. See `SelectMenu`.
 */

const FIELD_OPTIONS = RULE_FIELDS.map((f) => ({
  value: f.key,
  label: f.label,
  // The group does the work a heading would in a menu that had headings.
  hint: f.unit ? `${f.group} · ${f.unit}` : f.group,
}));

interface Props {
  rules: Rule[];
  onChange: (rules: Rule[]) => void;
}

export function RuleBuilder({ rules, onChange }: Props) {
  const patch = (id: string, next: Partial<Rule>) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...next } : r)));

  return (
    <div className="rules">
      {rules.length === 0 && (
        <p className="rules-empty">
          No conditions yet. Add one and the table narrows to the rows that satisfy every one of
          them — the bands above are the same idea with the numbers already chosen.
        </p>
      )}

      <ul className="rules-list">
        {rules.map((rule) => {
          const field = ruleField(rule.field);
          if (!field) return null;
          const ops = opsFor(field);

          return (
            <li key={rule.id} className="rule">
              <SelectMenu
                ariaLabel="Field"
                value={rule.field}
                options={FIELD_OPTIONS}
                onChange={(key) => patch(rule.id, retarget(rule, key))}
                minMenuWidth={240}
              />

              <SelectMenu
                ariaLabel="Operator"
                value={rule.op}
                options={ops.map((op) => ({ value: op, label: OP_LABEL[op] }))}
                onChange={(op) => patch(rule.id, { op: op as Rule['op'] })}
                minMenuWidth={140}
              />

              {field.options ? (
                <SelectMenu
                  ariaLabel={field.label}
                  value={rule.value}
                  options={field.options}
                  onChange={(value) => patch(rule.id, { value })}
                  minMenuWidth={180}
                />
              ) : (
                <span className="rule-operands">
                  {/* ₹ leads its figure and everything else follows it — the
                      same rule `withUnit` prints the chip by. */}
                  {field.unit === '₹' && <span className="rule-unit">₹</span>}
                  <input
                    className="rule-num"
                    type="number"
                    // `decimal` rather than `numeric`: several of these fields
                    // are percentages that are read to one place, and a phone
                    // keypad with no dot on it cannot type them.
                    inputMode="decimal"
                    step={field.step ?? 1}
                    value={rule.value}
                    aria-label={`${field.label} value`}
                    onChange={(e) => patch(rule.id, { value: e.target.value })}
                  />
                  {rule.op === 'between' && (
                    <>
                      <span className="rule-and">and</span>
                      <input
                        className="rule-num"
                        type="number"
                        inputMode="decimal"
                        step={field.step ?? 1}
                        value={rule.value2 ?? ''}
                        aria-label={`${field.label} upper value`}
                        onChange={(e) => patch(rule.id, { value2: e.target.value })}
                      />
                    </>
                  )}
                  {field.unit && field.unit !== '₹' && (
                    <span className="rule-unit">{field.unit}</span>
                  )}
                </span>
              )}

              <button
                type="button"
                className="icon-btn rule-drop"
                aria-label={`Remove the ${field.label} condition`}
                title="Remove this condition"
                onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className="btn ghost rule-add"
        onClick={() => onChange([...rules, newRule(RULE_FIELDS[0].key)])}
      >
        + Add condition
      </button>
    </div>
  );
}
