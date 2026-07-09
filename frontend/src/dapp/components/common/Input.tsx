import React, { useId } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  helperText?: string;
}

export default function Input({ label, helperText, id, className = '', ...props }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className="dapp-form-group">
      <label className="dapp-label" htmlFor={inputId}>
        {label}
      </label>
      <input id={inputId} className={`dapp-input ${className}`.trim()} {...props} />
      {helperText && <p className="dapp-helper">{helperText}</p>}
    </div>
  );
}
