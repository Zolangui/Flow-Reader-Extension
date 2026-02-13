import React from 'react'

type NavIconProps = {
  className?: string
  size?: number | string
  color?: string
}

export const GeminiIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    width="1em"
    height="1em"
    shapeRendering="geometricPrecision"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <g fill="none">
      <path d="m12.594 23.258l-.012.002l-.071.035l-.02.004l-.014-.004l-.071-.036q-.016-.004-.024.006l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.016-.018m.264-.113l-.014.002l-.184.093l-.01.01l-.003.011l.018.43l.005.012l.008.008l.201.092q.019.005.029-.008l.004-.014l-.034-.614q-.005-.019-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.003-.011l.018-.43l-.003-.012l-.01-.01z" />
      <path
        fill="currentColor"
        d="M12 2c.774 0 .949.711 1.173 1.292c.15.387.367.922.639 1.51c.559 1.21 1.294 2.526 2.077 3.31c.783.782 2.1 1.518 3.308 2.076c.589.272 1.124.49 1.511.64c.567.218 1.292.43 1.292 1.172c0 .774-.711.949-1.292 1.173c-.387.15-.922.367-1.51.639c-1.21.559-2.526 1.294-3.31 2.077c-.782.783-1.517 2.1-2.076 3.308a27 27 0 0 0-.64 1.511C12.95 21.286 12.769 22 12 22c-.761 0-.951-.718-1.173-1.292a26 26 0 0 0-.639-1.51c-.558-1.21-1.294-2.526-2.077-3.31c-.783-.782-2.1-1.517-3.308-2.076a26 26 0 0 0-1.511-.64C2.712 12.95 2 12.774 2 12s.711-.949 1.292-1.173c.387-.15.922-.367 1.51-.639c1.21-.558 2.526-1.294 3.31-2.077c.782-.783 1.518-2.1 2.076-3.308c.272-.589.49-1.124.64-1.511C11.047 2.719 11.235 2 12 2"
      />
    </g>
  </svg>
)

export const AnthropicIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    width="1em"
    height="1em"
    shapeRendering="geometricPrecision"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M16.765 5h-3.308l5.923 15h3.23zM7.226 5L1.38 20h3.308l1.307-3.154h6.154l1.23 3.077h3.309L10.688 5zm-.308 9.077l2-5.308l2.077 5.308z" />
  </svg>
)

export const OpenAIIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    width="1em"
    height="1em"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108a6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9a6.0462 6.0462 0 0 0 .7427 7.0966a5.98 5.98 0 0 0 .511 4.9107a6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058a5.9894 5.9894 0 0 0 3.9977-2.9001a6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804l4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852l4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852l-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998l2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
  </svg>
)

export const HomeIcon = ({ className, size = '1em', color }: NavIconProps) => (
  <svg
    viewBox="0 0 256 256"
    fill={color ?? 'currentColor'}
    width={size}
    height={size}
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M219.31,108.68l-80-80a16,16,0,0,0-22.62,0l-80,80A15.87,15.87,0,0,0,32,120v96a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V160h32v56a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V120A15.87,15.87,0,0,0,219.31,108.68ZM208,208H160V152a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v56H48V120l80-80,80,80Z" />
  </svg>
)

export const ExtensionSettingsIcon = ({
  className,
  size = '1em',
  color,
}: NavIconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    width={size}
    height={size}
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0a2.34 2.34 0 0 0 3.319 1.915a2.34 2.34 0 0 1 2.33 4.033a2.34 2.34 0 0 0 0 3.831a2.34 2.34 0 0 1-2.33 4.033a2.34 2.34 0 0 0-3.319 1.915a2.34 2.34 0 0 1-4.659 0a2.34 2.34 0 0 0-3.32-1.915a2.34 2.34 0 0 1-2.33-4.033a2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"
      stroke={color ?? 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle
      cx="12"
      cy="12"
      r="3"
      stroke={color ?? 'currentColor'}
      strokeWidth="2"
    />
  </svg>
)

export const LumenSparkleIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    width="1em"
    height="1em"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient
        id="lumen-sparkle-grad"
        x1="0%"
        y1="0%"
        x2="100%"
        y2="100%"
      >
        <stop offset="0%" stopColor="currentColor" stopOpacity="1" />
        <stop offset="100%" stopColor="currentColor" stopOpacity="0.6" />
      </linearGradient>
    </defs>
    {/* Main Sparkle */}
    <path
      d="M10 21C10 14.5 13 12 19 12C13 12 10 9.5 10 3C10 9.5 7 12 1 12C7 12 10 14.5 10 21Z"
      fill="url(#lumen-sparkle-grad)"
    />
    {/* Secondary Sparkle 1 */}
    <path
      d="M19 8C19 6.5 20 6 22 6C20 6 19 5.5 19 4C19 5.5 18 6 16 6C18 6 19 6.5 19 8Z"
      fill="currentColor"
      fillOpacity="0.8"
    />
  </svg>
)

export const IndexedIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 256 256"
    fill="currentColor"
    width="1em"
    height="1em"
    className={className}
  >
    <path d="M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"></path>
  </svg>
)
