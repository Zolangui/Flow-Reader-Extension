import clsx from 'clsx'
import React, { useState } from 'react'

import { RenditionSpread } from '@flow/epubjs'

import { useSettings } from '../state'

export const TypographySidebar: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'book' | 'global'>('book')
  const [settings, setSettings] = useSettings()

  const {
    fontSize,
    fontFamily,
    lineHeight,
    spread,
    zoom,
    contentWidthPercent,
  } = settings

  const handleFontSizeChange = (delta: number) => {
    const current = fontSize ? parseInt(fontSize) : 16
    setSettings((prev) => ({
      ...prev,
      fontSize: `${current + delta}px`,
    }))
  }

  const handleLineHeightChange = (delta: number) => {
    const current = lineHeight ?? 1.6
    setSettings((prev) => ({
      ...prev,
      lineHeight: Math.max(1, current + delta * 0.1),
    }))
  }

  const handleContentWidthChange = (delta: number) => {
    const current = contentWidthPercent ?? 100
    setSettings((prev) => ({
      ...prev,
      contentWidthPercent: Math.min(100, Math.max(50, current + delta * 5)),
    }))
  }

  const handleZoomChange = (delta: number) => {
    const current = zoom ?? 100
    setSettings((prev) => ({
      ...prev,
      zoom: Math.min(200, Math.max(50, current + delta * 10)),
    }))
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      {/* Header */}
      <div className="flex h-16 items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
        <div className="flex items-center">
          <button className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">
            <span className="material-symbols-outlined text-xl">
              text_fields
            </span>
          </button>
          <h2 className="ml-2 font-semibold text-gray-800 dark:text-white">
            Typography
          </h2>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('book')}
          className={clsx(
            'flex-1 py-2 text-sm font-semibold transition-colors',
            activeTab === 'book'
              ? 'border-primary text-primary border-b-2 dark:text-white'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
          )}
        >
          Book
        </button>
        <button
          onClick={() => setActiveTab('global')}
          className={clsx(
            'flex-1 py-2 text-sm font-semibold transition-colors',
            activeTab === 'global'
              ? 'border-primary text-primary border-b-2 dark:text-white'
              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
          )}
        >
          Global
        </button>
      </div>

      {/* Controls */}
      <div className="flex-grow space-y-5 overflow-y-auto p-4">
        {/* Page View */}
        <div>
          <label
            className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400"
            htmlFor="page-view"
          >
            Page View
          </label>
          <div className="relative">
            <select
              className="focus:ring-primary focus:border-primary w-full appearance-none rounded-md border-gray-300 bg-gray-100 py-2 pl-3 pr-8 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              id="page-view"
              value={spread === 'none' ? 'single' : 'double'}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  spread:
                    e.target.value === 'single'
                      ? ('none' as RenditionSpread)
                      : ('auto' as RenditionSpread),
                }))
              }
            >
              <option value="double">Double Page</option>
              <option value="single">Single Page</option>
            </select>
            <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">
              expand_more
            </span>
          </div>
        </div>

        {/* Font Family */}
        <div>
          <label
            className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400"
            htmlFor="font-family"
          >
            Font Family
          </label>
          <div className="relative">
            <select
              className="focus:ring-primary focus:border-primary w-full appearance-none rounded-md border-gray-300 bg-gray-100 py-2 pl-3 pr-8 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              id="font-family"
              value={fontFamily || 'serif'}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  fontFamily: e.target.value,
                }))
              }
            >
              <option value="serif">Serif</option>
              <option value="sans-serif">Sans-serif</option>
              <option value="monospace">Monospace</option>
            </select>
            <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">
              expand_more
            </span>
          </div>
        </div>

        {/* Font Size */}
        <div>
          <label
            className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400"
            htmlFor="font-size"
          >
            Font Size
          </label>
          <div className="flex items-center rounded-md border border-gray-300 dark:border-gray-600">
            <button
              onClick={() => handleFontSizeChange(-1)}
              className="rounded-l-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              -
            </button>
            <input
              className="w-full border-x border-gray-300 bg-gray-100 py-1.5 text-center text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              id="font-size"
              type="text"
              value={fontSize || 'Default'}
              readOnly
            />
            <button
              onClick={() => handleFontSizeChange(1)}
              className="rounded-r-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              +
            </button>
          </div>
        </div>

        {/* Line Height */}
        <div>
          <label
            className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400"
            htmlFor="line-height"
          >
            Line Height
          </label>
          <div className="flex items-center rounded-md border border-gray-300 dark:border-gray-600">
            <button
              onClick={() => handleLineHeightChange(-1)}
              className="rounded-l-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              -
            </button>
            <input
              className="w-full border-x border-gray-300 bg-gray-100 py-1.5 text-center text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              id="line-height"
              type="text"
              value={lineHeight?.toFixed(1) || 'Default'}
              readOnly
            />
            <button
              onClick={() => handleLineHeightChange(1)}
              className="rounded-r-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              +
            </button>
          </div>
        </div>

        {/* Content Width */}
        <div>
          <label
            className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400"
            htmlFor="content-width"
          >
            Content Width (%)
          </label>
          <div className="flex items-center rounded-md border border-gray-300 dark:border-gray-600">
            <button
              onClick={() => handleContentWidthChange(-1)}
              className="rounded-l-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              -
            </button>
            <input
              className="w-full border-x border-gray-300 bg-gray-100 py-1.5 text-center text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              id="content-width"
              type="text"
              value={contentWidthPercent ?? 100}
              readOnly
            />
            <button
              onClick={() => handleContentWidthChange(1)}
              className="rounded-r-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              +
            </button>
          </div>
        </div>

        {/* Zoom */}
        <div>
          <label
            className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400"
            htmlFor="zoom"
          >
            Zoom
          </label>
          <div className="flex items-center rounded-md border border-gray-300 dark:border-gray-600">
            <button
              onClick={() => handleZoomChange(-1)}
              className="rounded-l-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              -
            </button>
            <input
              className="w-full border-x border-gray-300 bg-gray-100 py-1.5 text-center text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              id="zoom"
              type="text"
              value={zoom ? `${zoom}%` : 'Default'}
              readOnly
            />
            <button
              onClick={() => handleZoomChange(1)}
              className="rounded-r-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-gray-200 p-4 dark:border-gray-700">
        <button className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">
          <span className="material-symbols-outlined text-xl">settings</span>
        </button>
      </div>
    </aside>
  )
}
