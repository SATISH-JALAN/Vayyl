import React from 'react';

export default function Card({ children, className = '', style }: { children: React.ReactNode, className?: string, style?: React.CSSProperties }) {
  return (
    <div className={`dapp-card ${className}`} style={style}>
      {children}
    </div>
  );
}
