// R67-r23 audit fix: report-route loading skeleton (was missing).

import Skeleton from "@/components/Skeleton";

export default function ReportLoading() {
  return (
    <div className="page-container">
      <div className="page-header">
        <Skeleton variant="text" />
        <Skeleton variant="text" />
      </div>
      <Skeleton variant="card" count={3} />
    </div>
  );
}
