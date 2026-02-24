export function Skeleton({ variant = 'text', count = 1 }: {
  variant?: 'text' | 'card' | 'table-row';
  count?: number;
}) {
  const variantClass =
    variant === 'text'
      ? 'skeleton-text'
      : variant === 'card'
        ? 'skeleton-card'
        : 'skeleton-table-row';

  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`skeleton ${variantClass}`} />
      ))}
    </>
  );
}

export default Skeleton;
