import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
}

export default function Card({ children, className = '' }: CardProps) {
  return <section className={`dapp-card ${className}`.trim()}>{children}</section>;
}
