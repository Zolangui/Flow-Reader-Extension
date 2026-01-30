import clsx from 'clsx'
import React from 'react'

import { useAction } from '../hooks'

interface NewSidebarProps {
  className?: string
}

export const NewSidebar: React.FC<NewSidebarProps> = ({ className }) => {
  const [action, setAction] = useAction()

  return (
    <aside
      className={clsx(
        'border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark flex flex-col items-center justify-between border-r p-2 sm:p-4',
        className,
      )}
    >
      <nav className="flex flex-col items-center gap-2">
        <NavItem
          icon="menu"
          active={action === 'toc'}
          onClick={() => setAction(action === 'toc' ? undefined : 'toc')}
        />
        <NavItem
          icon="library_books"
          active={action === 'books'}
          onClick={() => setAction(action === 'books' ? undefined : 'books')}
        />
        <NavItem
          icon="search"
          active={action === 'search'}
          onClick={() => setAction(action === 'search' ? undefined : 'search')}
        />
        <NavItem
          icon="format_underlined"
          active={action === 'annotation'}
          onClick={() =>
            setAction(action === 'annotation' ? undefined : 'annotation')
          }
        />
        <NavItem
          icon="image"
          active={action === 'image'}
          onClick={() => setAction(action === 'image' ? undefined : 'image')}
        />
        <NavItem
          icon="history"
          active={action === 'timeline'}
          onClick={() =>
            setAction(action === 'timeline' ? undefined : 'timeline')
          }
        />
        <NavItem
          icon="text_fields"
          active={action === 'typography'}
          onClick={() =>
            setAction(action === 'typography' ? undefined : 'typography')
          }
        />
        <NavItem
          icon="palette"
          active={action === 'theme'}
          onClick={() => setAction(action === 'theme' ? undefined : 'theme')}
        />
        <NavItem
          icon="smart_toy"
          active={action === 'chatbot'}
          onClick={() =>
            setAction(action === 'chatbot' ? undefined : 'chatbot')
          }
        />
      </nav>
      <div className="flex flex-col items-center">
        <button className="text-subtle-light dark:text-subtle-dark flex h-10 w-10 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5">
          <span className="material-symbols-outlined text-2xl">settings</span>
        </button>
      </div>
    </aside>
  )
}

interface NavItemProps {
  icon: string
  active?: boolean
  onClick?: () => void
}

const NavItem: React.FC<NavItemProps> = ({ icon, active, onClick }) => {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
        active
          ? 'bg-primary/20 text-primary dark:bg-primary/30'
          : 'text-subtle-light dark:text-subtle-dark hover:bg-black/5 dark:hover:bg-white/5',
      )}
    >
      <span className="material-symbols-outlined text-2xl">{icon}</span>
    </button>
  )
}
