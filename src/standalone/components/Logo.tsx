interface LogoProps {
  style?: React.CSSProperties;
}

export function Logo({ style }: LogoProps) {
  return (
    <svg
      style={style}
      xmlns="http://www.w3.org/2000/svg"
      width="148"
      height="118"
      viewBox="0 0 148 118"
    >
      <defs>
        <mask id="a">
          <path fill="#fff" d="M0 0h200v200H0z" />
          <circle cx="74" cy="59" r="42" />
          <path stroke="#000" strokeLinecap="round" strokeWidth="26" d="m89 74 33 33" />
        </mask>
      </defs>
      <g stroke="#000" mask="url(#a)">
        <rect width="60" height="110" x="4" y="4" fill="none" strokeWidth="8" rx="10" />
        <path
          strokeLinecap="round"
          strokeWidth="5"
          d="M18 24h32M18 36h22M28 48h22M38 60h12m-32 19h32m-32 12h16m-6 12h22"
        />
        <path strokeLinecap="round" strokeWidth="4.5" d="M22 60v10m-5-5h10" />
        <rect width="60" height="110" x="84" y="4" fill="none" strokeWidth="8" rx="10" />
        <path
          strokeLinecap="round"
          strokeWidth="5"
          d="M98 24h22m-22 12h32m-32 12h32m-22 12h22m-12 12h12m-32 12h32m-22 12h22"
        />
      </g>
      <circle cx="74" cy="59" r="30" fill="none" stroke="#000" strokeWidth="12" />
      <path stroke="#000" strokeLinecap="round" strokeWidth="14" d="m95 80 24 24" />
      <g fill="none" stroke="#000" strokeLinejoin="round" strokeWidth="4">
        <path d="m68 47 12 12-12 12-12-12Z" />
        <path d="m80 47 12 12-12 12-12-12Z" />
      </g>
      <path d="m74 53 6 6-6 6-6-6Z" />
    </svg>
  );
}
