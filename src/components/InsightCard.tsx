'use client';

import React from 'react';
import { AIInsight } from '@/types/trade';
import './InsightCard.css';

interface InsightCardProps {
  insight: AIInsight;
  onViewTrades?: (tradeIds: string[]) => void;
}

function WarningIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function PositiveIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function NeutralIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

const iconMap: Record<AIInsight['type'], () => React.ReactElement> = {
  warning: WarningIcon,
  positive: PositiveIcon,
  neutral: NeutralIcon,
};

export default function InsightCard({ insight, onViewTrades }: InsightCardProps) {
  const { type, title, description, severity, relatedTrades, category } = insight;
  const Icon = iconMap[type];

  return (
    <div className={`glass-card insight-card ${type} animate-fade-in`}>
      <div className="insight-card-header">
        <div className={`insight-card-icon ${type}`}>
          <Icon />
        </div>
        <div style={{ flex: 1 }}>
          <div className="insight-card-title">{title}</div>
        </div>
      </div>

      <div className="insight-card-severity">
        {Array.from({ length: 10 }, (_, i) => (
          <span
            key={i}
            className={`severity-dot${i < severity ? ` filled ${type}` : ''}`}
          />
        ))}
      </div>

      <p className="insight-card-description">{description}</p>

      <div className="insight-card-footer">
        <span className="insight-card-category">{category}</span>

        {relatedTrades.length > 0 && onViewTrades && (
          <button
            className="insight-view-trades"
            onClick={() => onViewTrades(relatedTrades)}
          >
            View {relatedTrades.length} related trade{relatedTrades.length !== 1 ? 's' : ''}
          </button>
        )}
      </div>
    </div>
  );
}
