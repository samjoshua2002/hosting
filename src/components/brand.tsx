// The hosting mark: two stacked server slabs on a dark tile, with a status light on the top one that takes the
// app's accent colour. Same drawing as app/icon.svg (the favicon).
export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8.5" fill="#0b0b0d" />
      <rect x=".5" y=".5" width="31" height="31" rx="8" fill="none" stroke="#ffffff" strokeOpacity=".12" />
      <rect x="7" y="8.5" width="18" height="6.5" rx="3.25" fill="#fafafa" />
      <rect x="7" y="17" width="18" height="6.5" rx="3.25" fill="#fafafa" fillOpacity=".42" />
      <circle cx="21.6" cy="11.75" r="1.55" fill="var(--accent, #10b981)" />
      <circle cx="21.6" cy="20.25" r="1.55" fill="#0b0b0d" fillOpacity=".55" />
    </svg>
  );
}
