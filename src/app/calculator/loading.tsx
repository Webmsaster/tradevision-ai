import Skeleton from '@/components/Skeleton';

export default function CalculatorLoading() {
  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <Skeleton variant="text" />
          <Skeleton variant="text" />
        </div>
      </div>
      <div className="calc-layout">
        <Skeleton variant="card" />
        <Skeleton variant="card" />
      </div>
    </div>
  );
}
