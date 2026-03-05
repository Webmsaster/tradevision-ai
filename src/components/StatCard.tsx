'use client';

import React from 'react';

interface StatCardProps {
  label: string;
  value: string | number;
  prefix?: string;
  suffix?: string;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  variant?: 'default' | 'profit' | 'loss';
  icon?: React.ReactNode;
}

export default function StatCard({
  label,
  value,
  prefix = '',
  suffix = '',
  trend,
  trendValue,
  variant = 'default',
  icon,
}: StatCardProps) {
  const glowClass =
    variant === 'profit'
      ? 'profit-glow'
      : variant === 'loss'
        ? 'loss-glow'
        : '';

  const valueClass =
    variant === 'profit'
      ? 'profit'
      : variant === 'loss'
        ? 'loss'
        : '';

  return (
    <div className={`glass-card stat-card animate-fade-in ${glowClass}`}>
      <div className="stat-card-header">
        <span className="stat-label">{label}</span>
        {icon && <span className="stat-card-icon">{icon}</span>}
      </div>

      <span className={`stat-card-value stat-value ${valueClass}`}>
        {prefix}{value}{suffix}
      </span>

      {trend && trendValue && (
        <div className={`stat-card-trend ${trend}`}>
          {trend === 'up' && (
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 2L10 7H2L6 2Z" fill="currentColor" />
            </svg>
          )}
          {trend === 'down' && (
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 10L2 5H10L6 10Z" fill="currentColor" />
            </svg>
          )}
          {trend === 'neutral' && (
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 6H10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
          <span>{trendValue}</span>
        </div>
      )}
    </div>
  );
}
