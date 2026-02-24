import Skeleton from '@/components/Skeleton';

export default function AnalyticsLoading() {
  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <Skeleton variant="text" />
          <Skeleton variant="text" />
        </div>
      </div>
      <div className="analytics-stats-grid">
        <Skeleton variant="card" count={4} />
      </div>
      <div className="analytics-stats-grid">
        <Skeleton variant="card" count={4} />
      </div>
    </div>
  );
}
