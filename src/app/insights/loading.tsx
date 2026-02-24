import Skeleton from '@/components/Skeleton';

export default function InsightsLoading() {
  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <Skeleton variant="text" />
          <Skeleton variant="text" />
        </div>
      </div>
      <Skeleton variant="card" count={3} />
    </div>
  );
}
