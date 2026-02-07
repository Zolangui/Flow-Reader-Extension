import React from 'react'

export const GeminiIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em" className={className} xmlns="http://www.w3.org/2000/svg">
        <path d="M19.006 3.705a.75.75 0 0 0-.512-1.41L6 6.838V22h14.25a.75.75 0 0 0 0-1.5H7.5v-13l11.506-4.795zm-14.25 0a.75.75 0 0 0-.512 1.41l11.506 4.795v13H1.5a.75.75 0 0 0 0 1.5H15.75V6.838L4.756 3.705z" fillOpacity={0} />
        <path d="M11.97 2.1c-.08-.66-.62-1.2-1.28-1.2-3.9 0-7.05 3.15-7.05 7.05 0 1.95 2.1 4.2 4.2 5.7.9.64 2.1 1.25 2.85 1.76.75-.51 1.95-1.12 2.85-1.76 2.1-1.5 4.2-3.75 4.2-5.7 0-3.9-3.15-7.05-7.05-7.05-.66 0-1.2.54-1.28 1.2h-.44zM12 13.8c-1.8-1.2-3.6-3.15-3.6-4.65 0-2.4 1.8-4.2 4.2-4.2s4.2 1.8 4.2 4.2c0 1.5-1.8 3.45-3.6 4.65h-1.2z" className="hidden" />
        {/* Actual Sparkle Shape */}
        <path d="M13.87 3.16l-1.33 3.96a.7.7 0 0 1-.41.42l-3.99 1.34c-.45.15-.45.79 0 .94l3.99 1.34c.18.06.33.2.39.38l1.35 4a.69.69 0 0 0 1.32 0l1.35-4a.7.7 0 0 1 .39-.38l4-1.34c.45-.15.45-.79 0-.94l-4-1.34a.7.7 0 0 1-.41-.42l-1.33-3.96a.69.69 0 0 0-1.32 0z" />
        <path d="M7.4 14.8l-.66 1.96a.35.35 0 0 1-.22.2l-2 .66c-.22.08-.22.4 0 .47l2 .67c.09.03.16.1.19.19l.69 2.01c.07.22.39.22.46 0l.69-2.01a.34.34 0 0 1 .19-.19l2.01-.67c.22-.07.22-.39 0-.47l-2.01-.66a.35.35 0 0 1-.22-.2l-.66-1.96a.35.35 0 0 1-.46 0z" />
    </svg>
)

export const AnthropicIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em" className={className} xmlns="http://www.w3.org/2000/svg">
        <path d="M17.76 19.12H19.98L13.84 4.54C13.58 3.92 12.98 3.52 12.31 3.52H11.66C10.99 3.52 10.39 3.92 10.13 4.54L4.02 19.12H6.24L7.54 16.03H16.46L17.76 19.12ZM8.42 13.92L11.95 5.5H12.02L15.55 13.92H8.42Z" />
    </svg>
)

export const LumenSparkleIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" fill="none" width="1em" height="1em" className={className} xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="lumen-sparkle-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="currentColor" stopOpacity="1" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0.6" />
            </linearGradient>
        </defs>
        {/* Main Sparkle */}
        <path
            d="M12 2L14.43 8.35L21 10.5L14.43 12.65L12 19L9.57 12.65L3 10.5L9.57 8.35L12 2Z"
            fill="url(#lumen-sparkle-grad)"
        />
        {/* Secondary Sparkle 1 */}
        <path
            d="M19 14L20.06 16.73L22.8 17.65L20.06 18.57L19 21.3L17.94 18.57L15.2 17.65L17.94 16.73L19 14Z"
            fill="currentColor"
            fillOpacity="0.8"
        />
        {/* Secondary Sparkle 2 */}
        <path
            d="M6 14L6.75 15.93L8.7 16.6L6.75 17.27L6 19.2L5.25 17.27L3.3 16.6L5.25 15.93L6 14Z"
            fill="currentColor"
            fillOpacity="0.5"
        />
    </svg>
)
