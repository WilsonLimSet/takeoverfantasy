/**
 * Takeover Fantasy's mark: a basketball whose seam rises out of it as an arrow, up and to the
 * right. Same drawing as src/app/icon.svg (the dark seam underneath cuts the gap in the ball).
 */
const MARK_SEAM = "M23 65C44 65 52 40 80 25M76.1 36.4L80 25L68.4 21.9";

export function LogoMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden="true">
      <rect width="100" height="100" rx="23" fill="#191919" />
      <circle cx="50" cy="50" r="30" fill="none" stroke="#faf8f7" strokeWidth="6" />
      <path d={MARK_SEAM} fill="none" stroke="#191919" strokeWidth="15" strokeLinecap="round" strokeLinejoin="round" />
      <path d={MARK_SEAM} fill="none" stroke="#3fa37a" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
