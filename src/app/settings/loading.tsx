import Skeleton from '@/components/Skeleton';

export default function SettingsLoading() {
  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <Skeleton variant="text" />
          <Skeleton variant="text" />
        </div>
      </div>
      <Skeleton variant="card" />
      <Skeleton variant="card" />
      <Skeleton variant="card" />
    </div>
  );
}
