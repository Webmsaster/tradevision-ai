// R67-r23 audit fix: root-route loading skeleton (was missing — root nav
// showed a blank screen during navigation). Mirrors the analytics/loading
// shell pattern.

import Skeleton from "@/components/Skeleton";

export default function DashboardLoading() {
  return (
    <div className="page-container">
      <div className="dashboard-header">
        <Skeleton variant="text" />
        <Skeleton variant="text" />
      </div>
      <div className="dashboard-kpi-grid">
        <Skeleton variant="card" count={4} />
      </div>
      <div className="dashboard-kpi-secondary">
        <Skeleton variant="card" count={3} />
      </div>
      <Skeleton variant="card" />
    </div>
  );
}
