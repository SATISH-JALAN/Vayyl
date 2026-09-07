'use client';

import { useId } from 'react';

import AssetLogo from '../common/AssetLogo';
import { getMarket } from '../../lib/assets';

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Sits under the field. Rendered in the error tone when `invalid`. */
  hint: string;
  invalid?: boolean;
  /**
   * Convenience amounts. These are PRESETS, not balances — this page never
   * reads the wallet's public XLM, so a chip here promises nothing about what
   * the account can afford.
   */
  presets?: string[];
  /**
   * A real, computed ceiling — the largest amount this action can actually
   * move. Rendered only when one exists, so "Max" is never a guess.
   */
  max?: { label: string; value: string } | null;
  label?: string;
}

/**
 * The amount field, as the primary control it is.
 *
 * The old form gave the amount the same weight as a paragraph of helper text:
 * one `dapp-input` among several, in a column of equals. On a page whose entire
 * job is "how much", that is the thing to look at first, so it gets the size and
 * the asset pill and the presets, and everything else arranges itself around it.
 */
export default function AmountField({
  value,
  onChange,
  disabled,
  hint,
  invalid,
  presets,
  max,
  label = 'Amount',
}: Props) {
  const id = useId();
  const market = getMarket('xlm-usd');
  const hasChips = (presets && presets.length > 0) || !!max;

  return (
    <div className="vy-amount-field">
      <label className="vy-field-label" htmlFor={id}>
        {label}
      </label>

      <div className={`vy-amount-field__box ${invalid ? 'is-invalid' : ''}`.trim()}>
        <input
          id={id}
          className="vy-amount-field__input dapp-mono"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-invalid={invalid || undefined}
        />
        <span className="vy-amount-field__asset">
          <AssetLogo asset={market.base} size={18} />
          XLM
        </span>
      </div>

      {hasChips && (
        <div className="vy-chips">
          {presets?.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`vy-chip ${value === preset ? 'is-active' : ''}`.trim()}
              onClick={() => onChange(preset)}
              disabled={disabled}
            >
              {preset}
            </button>
          ))}
          {max && (
            <button
              type="button"
              className={`vy-chip vy-chip--max ${value === max.value ? 'is-active' : ''}`.trim()}
              onClick={() => onChange(max.value)}
              disabled={disabled}
            >
              {max.label}
            </button>
          )}
        </div>
      )}

      <p className={`vy-field-hint ${invalid ? 'is-error' : ''}`.trim()}>{hint}</p>
    </div>
  );
}
