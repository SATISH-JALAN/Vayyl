import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
}

export default function Input({ label, className = '', ...props }: InputProps) {
  return (
    <div className="dapp-form-group">
      <label className="dapp-label">{label}</label>
      <input className={`dapp-input ${className}`} {...props} />
    </div>
  );
}
