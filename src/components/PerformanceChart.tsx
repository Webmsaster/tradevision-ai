'use client';

import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
} from 'recharts';
import { Trade, PerformanceByTime } from '@/types/trade';
import './PerformanceChart.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PerformanceChartProps {
  type: 'pnl-distribution' | 'win-loss-pie' | 'by-day' | 'by-hour' | 'by-pair';
  trades: Trade[];
  data?: PerformanceByTime[];
  height?: number;
}

interface BucketDatum {
  label: string;
  count: number;
  isPositive: boolean;
}

interface PairDatum {
  pair: string;
  totalPnl: number;
}

interface PieDatum {
  name: string;
  value: number;
  color: string;
  percent: number;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const GREEN = '#00ff88';
const RED = '#ff4757';

// ---------------------------------------------------------------------------
// Chart titles
// ---------------------------------------------------------------------------

const TITLES: Record<PerformanceChartProps['type'], string> = {
  'pnl-distribution': 'PnL Distribution',
  'win-loss-pie': 'Win / Loss Ratio',
  'by-day': 'Performance by Day',
  'by-hour': 'Performance by Hour',
  'by-pair': 'Performance by Pair',
};

// ---------------------------------------------------------------------------
// Custom tooltips
// ---------------------------------------------------------------------------

function DistributionTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="perf-tooltip">
      <div className="perf-tooltip-label">{label}</div>
      <div className="perf-tooltip-value">{payload[0].value} trade{payload[0].value !== 1 ? 's' : ''}</div>
    </div>
  );
}

function PieTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as PieDatum;
  return (
    <div className="perf-tooltip">
      <div className="perf-tooltip-label">{d.name}</div>
      <div className="perf-tooltip-value">
        {d.value} trade{d.value !== 1 ? 's' : ''} ({d.percent.toFixed(1)}%)
      </div>
    </div>
  );
}

function TimeTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as PerformanceByTime;
  return (
    <div className="perf-tooltip">
      <div className="perf-tooltip-label">{label}</div>
      <div className="perf-tooltip-value" style={{ color: d.totalPnl >= 0 ? GREEN : RED }}>
        ${d.totalPnl.toFixed(2)}
      </div>
      <div className="perf-tooltip-value">
        {d.trades} trade{d.trades !== 1 ? 's' : ''} &middot; {d.winRate.toFixed(1)}% WR
      </div>
    </div>
  );
}

function PairTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as PairDatum;
  return (
    <div className="perf-tooltip">
      <div className="perf-tooltip-label">{d.pair}</div>
      <div className="perf-tooltip-value" style={{ color: d.totalPnl >= 0 ? GREEN : RED }}>
        ${d.totalPnl.toFixed(2)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom pie label
// ---------------------------------------------------------------------------

function renderPieLabel({
  cx,
  cy,
  midAngle,
  innerRadius,
  outerRadius,
  percent,
  name,
}: any) {
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);

  if (percent < 0.05) return null;

  return (
    <text
      x={x}
      y={y}
      className="pie-label"
      textAnchor="middle"
      dominantBaseline="central"
    >
      {name} {(percent * 100).toFixed(0)}%
    </text>
  );
}

// ---------------------------------------------------------------------------
// Data builders
// ---------------------------------------------------------------------------

function buildDistributionData(trades: Trade[]): BucketDatum[] {
  if (trades.length === 0) return [];

  const pnls = trades.map((t) => t.pnl);
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);

  // Determine nice bucket boundaries that include 0 as a boundary
  const absMax = Math.max(Math.abs(min), Math.abs(max));
  const step = niceStep(absMax);

  // Build boundary array from negative to positive
  const boundaries: number[] = [];
  let b = 0;
  while (b + step < absMax * 1.01) {
    b += step;
  }
  // negative side
  const negBounds: number[] = [];
  for (let v = -b; v < 0; v += step) {
    negBounds.push(Math.round(v * 100) / 100);
  }
  // positive side
  const posBounds: number[] = [0];
  for (let v = step; v <= b + step * 0.01; v += step) {
    posBounds.push(Math.round(v * 100) / 100);
  }
  const allBounds = [...negBounds, ...posBounds];

  // Create buckets
  const buckets: BucketDatum[] = [];
  // Below min boundary
  if (min < allBounds[0]) {
    buckets.push({ label: `< ${fmt(allBounds[0])}`, count: 0, isPositive: allBounds[0] >= 0 });
  }
  for (let i = 0; i < allBounds.length - 1; i++) {
    const lo = allBounds[i];
    const hi = allBounds[i + 1];
    buckets.push({
      label: `${fmt(lo)} to ${fmt(hi)}`,
      count: 0,
      isPositive: lo >= 0,
    });
  }
  // Above max boundary
  if (max >= allBounds[allBounds.length - 1]) {
    const last = allBounds[allBounds.length - 1];
    buckets.push({ label: `> ${fmt(last)}`, count: 0, isPositive: last >= 0 });
  }

  // Fill buckets
  for (const pnl of pnls) {
    let placed = false;
    // Check below-min bucket
    if (buckets.length > 0 && min < allBounds[0] && pnl < allBounds[0]) {
      buckets[0].count++;
      placed = true;
    }
    if (!placed) {
      const offset = min < allBounds[0] ? 1 : 0;
      for (let i = 0; i < allBounds.length - 1; i++) {
        if (pnl >= allBounds[i] && pnl < allBounds[i + 1]) {
          buckets[i + offset].count++;
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      // Falls in the last (above-max) bucket
      buckets[buckets.length - 1].count++;
    }
  }

  // Remove empty edge buckets
  while (buckets.length > 0 && buckets[0].count === 0) buckets.shift();
  while (buckets.length > 0 && buckets[buckets.length - 1].count === 0) buckets.pop();

  return buckets;
}

function niceStep(absMax: number): number {
  if (absMax <= 0) return 50;
  // Aim for roughly 4-6 buckets per side
  const raw = absMax / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let nice: number;
  if (norm <= 1.5) nice = 1;
  else if (norm <= 3) nice = 2;
  else if (norm <= 7) nice = 5;
  else nice = 10;
  return nice * mag;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(0);
}

function buildPieData(trades: Trade[]): PieDatum[] {
  if (trades.length === 0) return [];
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.length - wins;
  const total = trades.length;
  return [
    { name: 'Wins', value: wins, color: GREEN, percent: (wins / total) * 100 },
    { name: 'Losses', value: losses, color: RED, percent: (losses / total) * 100 },
  ];
}

function buildPairData(trades: Trade[]): PairDatum[] {
  if (trades.length === 0) return [];
  const map: Record<string, number> = {};
  for (const t of trades) {
    map[t.pair] = (map[t.pair] || 0) + t.pnl;
  }
  return Object.entries(map)
    .map(([pair, totalPnl]) => ({ pair, totalPnl: Math.round(totalPnl * 100) / 100 }))
    .sort((a, b) => b.totalPnl - a.totalPnl);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PerformanceChart({
  type,
  trades,
  data,
  height = 300,
}: PerformanceChartProps) {
  // ---- derived data ----
  const distributionData = useMemo(
    () => (type === 'pnl-distribution' ? buildDistributionData(trades) : []),
    [type, trades],
  );

  const pieData = useMemo(
    () => (type === 'win-loss-pie' ? buildPieData(trades) : []),
    [type, trades],
  );

  const pairData = useMemo(
    () => (type === 'by-pair' ? buildPairData(trades) : []),
    [type, trades],
  );

  // ---- empty state ----
  const isEmpty =
    (type === 'pnl-distribution' && distributionData.length === 0) ||
    (type === 'win-loss-pie' && pieData.length === 0) ||
    ((type === 'by-day' || type === 'by-hour') && (!data || data.length === 0)) ||
    (type === 'by-pair' && pairData.length === 0);

  if (isEmpty) {
    return (
      <div className="performance-chart">
        <div className="performance-chart-title">{TITLES[type]}</div>
        <div className="performance-chart-empty">No data available</div>
      </div>
    );
  }

  // ---- render helpers ----

  const renderDistribution = () => (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={distributionData} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey="label"
          tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
          axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
          axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
          tickLine={false}
        />
        <Tooltip content={<DistributionTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
        <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={48}>
          {distributionData.map((d, i) => (
            <Cell key={i} fill={d.isPositive ? GREEN : RED} fillOpacity={0.8} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  const renderPie = () => (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={pieData}
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={100}
          dataKey="value"
          label={renderPieLabel}
          labelLine={false}
          strokeWidth={0}
        >
          {pieData.map((d, i) => (
            <Cell key={i} fill={d.color} />
          ))}
        </Pie>
        <Tooltip content={<PieTooltip />} />
      </PieChart>
    </ResponsiveContainer>
  );

  const renderTimeChart = () => {
    if (!data) return null;
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis
            dataKey="label"
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
            tickLine={false}
            tickFormatter={(v: number) =>
              Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v}`
            }
          />
          <Tooltip content={<TimeTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
          <Bar dataKey="totalPnl" radius={[4, 4, 0, 0]} maxBarSize={48}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.totalPnl >= 0 ? GREEN : RED} fillOpacity={0.8} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  };

  const renderPairChart = () => {
    const chartHeight = Math.max(height, pairData.length * 40);
    return (
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={pairData}
          layout="vertical"
          margin={{ top: 4, right: 12, bottom: 4, left: 60 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
            tickLine={false}
            tickFormatter={(v: number) =>
              Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v}`
            }
          />
          <YAxis
            type="category"
            dataKey="pair"
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
            tickLine={false}
            width={56}
          />
          <Tooltip content={<PairTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
          <Bar dataKey="totalPnl" radius={[0, 4, 4, 0]} maxBarSize={28}>
            {pairData.map((d, i) => (
              <Cell key={i} fill={d.totalPnl >= 0 ? GREEN : RED} fillOpacity={0.8} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  };

  // ---- chart selector ----
  const chartMap: Record<PerformanceChartProps['type'], () => React.ReactNode> = {
    'pnl-distribution': renderDistribution,
    'win-loss-pie': renderPie,
    'by-day': renderTimeChart,
    'by-hour': renderTimeChart,
    'by-pair': renderPairChart,
  };

  return (
    <div className="performance-chart">
      <div className="performance-chart-title">{TITLES[type]}</div>
      <div className="performance-chart-container">{chartMap[type]()}</div>
    </div>
  );
}
