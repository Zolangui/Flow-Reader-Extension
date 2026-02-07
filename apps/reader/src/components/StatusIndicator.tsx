import clsx from 'clsx'
import React from 'react'
import { MdCheckCircle, MdError, MdWarning, MdCloudDownload, MdHourglassEmpty } from 'react-icons/md'

export type StatusType = 'unknown' | 'downloading' | 'ready' | 'error' | 'warning'

interface StatusIndicatorProps {
    label: string
    status: StatusType
    progress?: number
    onClick?: () => void
    icon?: React.ReactNode
    tooltip?: string
    statusText?: Record<string, string>
    errorMessage?: string | null
    warningMessage?: string | null
    className?: string
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
    label,
    status,
    progress,
    onClick,
    icon,
    tooltip,
    statusText,
    errorMessage,
    warningMessage,
    className
}) => {
    const isDownloading = status === 'downloading'
    const isSuccess = status === 'ready' || status === 'warning'
    const hasWarning = status === 'warning' || !!warningMessage

    const getIcon = () => {
        switch (status) {
            case 'ready': return <MdCheckCircle className="text-green-500" />
            case 'error': return <MdError className="text-red-500" />
            // Warning means "downloaded/working, but with a known limitation" (e.g. single-thread in Firefox MV3).
            case 'warning':
                return (
                    <span className="flex items-center gap-0.5">
                        <MdCheckCircle className="text-green-500" />
                        <MdWarning className="text-yellow-500" />
                    </span>
                )
            case 'downloading': return <MdHourglassEmpty className="text-blue-500 animate-spin" />
            default: return <MdCloudDownload className="text-subtle" />
        }
    }

    const getText = () => {
        if (status === 'error' && errorMessage) return errorMessage
        if (status === 'warning') {
            const ready = statusText?.ready || 'ready'
            const warn = warningMessage || statusText?.warning || 'warning'
            return warn ? `${ready}\n${warn}` : ready
        }
        if (status === 'unknown') return statusText?.clickToDownload || status
        if (status === 'downloading' && typeof progress === 'number' && Number.isFinite(progress)) {
            const pct = Math.max(0, Math.min(100, Math.round(progress)))
            const base = statusText?.downloading || status
            return pct > 0 ? `${base} (${pct}%)` : base
        }
        return statusText?.[status] || status
    }

    const titleText = [tooltip, getText()].filter(Boolean).join('\n')

    const handleClick = () => {
        if (isDownloading) return
        onClick?.()
    }

    return (
        <button
            type="button"
            onClick={handleClick}
            title={titleText}
            // Do NOT set `disabled` for ready/warning; disabled buttons don't show tooltips in Firefox.
            aria-disabled={isDownloading || !onClick}
            className={clsx(
                "flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium border transition-all",
                isSuccess ? "bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400" :
                    status === 'error' ? "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400" :
                        status === 'downloading' ? "bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400" :
                                "bg-surface-2 border-border-light hover:bg-surface-3 text-subtle hover:text-text",
                (isDownloading || !onClick) ? "cursor-default opacity-90" : "cursor-pointer",
                className
            )}
        >
            <span className="opacity-70">{icon}</span>
            <span>{label}</span>
            <span className="text-xs">{getIcon()}</span>
            {/* For consumers that pass `warningMessage` without setting `status="warning"` */}
            {status !== 'warning' && hasWarning && (
                <span className="text-xs" title={warningMessage || statusText?.warning || ''}>
                    <MdWarning className="text-yellow-500" />
                </span>
            )}
        </button>
    )
}
