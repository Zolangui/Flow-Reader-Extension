import { Overlay } from '@literal-ui/core'
import clsx from 'clsx'
import dynamic from 'next/dynamic'
import { ComponentProps, useEffect, useMemo, useState } from 'react'
import { IconType } from 'react-icons'
import {
  MdFormatUnderlined,
  MdImage,
  MdSearch,
  MdToc,
  MdTimeline,
  MdPalette,
  MdTextFields,
  MdSelfImprovement,
  MdLibraryBooks,
  MdSmartToy,
  MdClose,
} from 'react-icons/md'
import { useRecoilState } from 'recoil'

import {
  Env,
  useAction,
  useBackground,
  useColorScheme,
  useMobile,
  ReadingTrackerProvider,
  useSetAction,
  useTranslation,
  useZenModeHandler,
} from '../hooks'
import type { Action } from '../hooks'
import { reader, useReaderSnapshot } from '../models'
import { navbarState, useZenMode } from '../state'
import { activeClass } from '../styles'

import { SplitView, useSplitViewItem } from './base'
import {
  ExtensionSettingsIcon as _ExtensionSettingsIcon,
  HomeIcon as _HomeIcon,
} from './icons/ProviderIcons'
import { Settings } from './pages'
import { AnnotationView } from './viewlets/AnnotationView'
import { ImageView } from './viewlets/ImageView'
import { LibrarySideView } from './viewlets/LibrarySideView'
import { SearchView } from './viewlets/SearchView'
import { ThemeView } from './viewlets/ThemeView'
import { TimelineView } from './viewlets/TimelineView'
import { TocView } from './viewlets/TocView'
import { TypographyView } from './viewlets/TypographyView'

const ChatbotSidebar = dynamic(
  () => import('./ChatbotSidebar').then((m) => m.ChatbotSidebar),
  { ssr: false },
)

const HomeIcon = _HomeIcon as unknown as IconType
const ExtensionSettingsIcon = _ExtensionSettingsIcon as unknown as IconType

export const Layout: React.FC<{ children?: React.ReactNode }> = ({
  children,
}) => {
  useColorScheme()
  const { toggleZenMode } = useZenModeHandler()
  const [isZenMode] = useZenMode()
  const [ready, setReady] = useState(false)
  const [showZenHint, setShowZenHint] = useState(false)
  const setAction = useSetAction()
  const mobile = useMobile()
  const t = useTranslation()

  useEffect(() => {
    if (isZenMode) setShowZenHint(true)
  }, [isZenMode])

  useEffect(() => {
    if (mobile === undefined) return
    setAction(mobile ? undefined : 'toc')
    setReady(true)
  }, [mobile, setAction])

  return (
    <ReadingTrackerProvider>
      <div id="layout" className="select-none">
        <SplitView>
          {!isZenMode && mobile === false && <ActivityBar />}
          {!isZenMode && mobile === true && <NavigationBar />}
          {!isZenMode && ready && <SideBar />}
          {ready && <Reader>{children}</Reader>}
        </SplitView>
        {isZenMode && showZenHint && (
          <div className="fixed inset-x-0 top-3 z-50 flex justify-center px-4">
            <div className="flex items-center gap-3 rounded-full bg-black/70 px-4 py-2 text-xs font-medium text-white shadow-lg backdrop-blur">
              <span>{t('zen.exit_hint')}</span>
              <button
                type="button"
                onClick={() => void toggleZenMode()}
                className="bg-white/15 rounded-full px-2.5 py-1 font-semibold transition-colors hover:bg-white/25"
              >
                {t('zen.exit_action')}
              </button>
              <button
                type="button"
                onClick={() => setShowZenHint(false)}
                aria-label={t('zen.dismiss_hint')}
                title={t('zen.dismiss_hint')}
                className="hover:bg-white/15 rounded-full p-1 text-white/75 transition-colors hover:text-white"
              >
                <MdClose className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </ReadingTrackerProvider>
  )
}

interface IAction {
  name: string
  title: string
  Icon: IconType
  env: number
}
interface IViewAction extends IAction {
  name: Action
  View: React.ComponentType<any>
}

const viewActions: IViewAction[] = [
  {
    name: 'books',
    title: 'books',
    Icon: MdLibraryBooks,
    View: LibrarySideView,
    env: Env.Desktop | Env.Mobile,
  },
  {
    name: 'toc',
    title: 'toc',
    Icon: MdToc,
    View: TocView,
    env: Env.Desktop | Env.Mobile,
  },
  {
    name: 'search',
    title: 'search',
    Icon: MdSearch,
    View: SearchView,
    env: Env.Desktop | Env.Mobile,
  },
  {
    name: 'annotation',
    title: 'annotation',
    Icon: MdFormatUnderlined,
    View: AnnotationView,
    env: Env.Desktop | Env.Mobile,
  },
  {
    name: 'image',
    title: 'image',
    Icon: MdImage,
    View: ImageView,
    env: Env.Desktop,
  },
  {
    name: 'timeline',
    title: 'timeline',
    Icon: MdTimeline,
    View: TimelineView,
    env: Env.Desktop,
  },
  {
    name: 'typography',
    title: 'typography',
    Icon: MdTextFields,
    View: TypographyView,
    env: Env.Desktop | Env.Mobile,
  },
  {
    name: 'theme',
    title: 'theme',
    Icon: MdPalette,
    View: ThemeView,
    env: Env.Desktop | Env.Mobile,
  },
  {
    name: 'chatbot',
    title: 'ai',
    Icon: MdSmartToy,
    View: ChatbotSidebar,
    env: Env.Desktop | Env.Mobile,
  },
]

const ActivityBar: React.FC = () => {
  useSplitViewItem(ActivityBar, {
    preferredSize: 48,
    minSize: 48,
    maxSize: 48,
  })
  return (
    <div className="ActivityBar flex flex-col justify-between">
      <ViewActionBar env={Env.Desktop} />
      <PageActionBar env={Env.Desktop} />
    </div>
  )
}

interface EnvActionBarProps extends ComponentProps<'div'> {
  env: Env
}

function ViewActionBar({ className, env }: EnvActionBarProps) {
  const [action, setAction] = useAction()
  const t = useTranslation()
  const [isZenMode] = useZenMode()
  const { toggleZenMode } = useZenModeHandler({ listen: false })

  return (
    <ActionBar className={className}>
      {viewActions
        .filter((a) => a.env & env)
        .map(({ name, title, Icon }) => {
          const active = action === name
          return (
            <Action
              title={t(`${title}.title`)}
              Icon={Icon}
              active={active}
              onClick={() => setAction(active ? undefined : name)}
              key={name}
            />
          )
        })}
      <Action
        title={t('zen.title')}
        Icon={MdSelfImprovement}
        active={isZenMode}
        onClick={toggleZenMode}
      />
    </ActionBar>
  )
}

function PageActionBar({ env }: EnvActionBarProps) {
  const mobile = useMobile()
  const [action, setAction] = useState('Home')
  const t = useTranslation()

  interface IPageAction extends IAction {
    Component?: React.FC
    disabled?: boolean
  }

  const pageActions: IPageAction[] = useMemo(
    () => [
      {
        name: 'home',
        title: 'home',
        Icon: HomeIcon,
        env: Env.Mobile,
      },
      {
        name: 'settings',
        title: 'settings',
        Icon: ExtensionSettingsIcon,
        Component: Settings,
        env: Env.Desktop | Env.Mobile,
      },
    ],
    [],
  )

  return (
    <ActionBar>
      {pageActions
        .filter((a) => a.env & env)
        .map(({ name, title, Icon, Component, disabled }, i) => (
          <Action
            title={t(`${title}.title`)}
            Icon={Icon}
            active={mobile ? action === name : undefined}
            disabled={disabled}
            onClick={() => {
              Component ? reader.addTab(Component) : reader.clear()
              setAction(name)
            }}
            key={i}
          />
        ))}
    </ActionBar>
  )
}

function NavigationBar() {
  const r = useReaderSnapshot()
  const readMode = r.focusedTab?.isBook
  const [visible, setVisible] = useRecoilState(navbarState)

  return (
    <>
      {visible && (
        <Overlay
          className="!bg-transparent"
          onClick={() => setVisible(false)}
        />
      )}
      <div className="NavigationBar bg-surface border-surface-variant fixed inset-x-0 bottom-0 z-10 border-t">
        {readMode ? (
          <ViewActionBar
            env={Env.Mobile}
            className={clsx(visible || 'hidden')}
          />
        ) : (
          <PageActionBar env={Env.Mobile} />
        )}
      </div>
    </>
  )
}

interface ActionBarProps extends ComponentProps<'ul'> {}
function ActionBar({ className, ...props }: ActionBarProps) {
  return (
    <ul className={clsx('ActionBar flex sm:flex-col', className)} {...props} />
  )
}

interface ActionProps extends ComponentProps<'button'> {
  Icon: IconType
  active?: boolean
}
const Action: React.FC<ActionProps> = ({
  className,
  Icon,
  active,
  ...props
}) => {
  const mobile = useMobile()
  return (
    <button
      className={clsx(
        'Action relative flex h-12 w-12 flex-1 items-center justify-center sm:flex-initial',
        active ? 'text-on-surface-variant' : 'text-outline/70',
        props.disabled ? 'text-on-disabled' : 'hover:text-on-surface-variant ',
        className,
      )}
      {...props}
    >
      {active &&
        (mobile || (
          <div
            className={clsx('absolute', 'inset-y-0 left-0 w-0.5', activeClass)}
          />
        ))}
      <Icon size={28} />
    </button>
  )
}

const SideBar: React.FC = () => {
  const [action, setAction] = useAction()
  const mobile = useMobile()
  const t = useTranslation()
  const [renderedAction, setRenderedAction] = useState(action)

  const { size } = useSplitViewItem(SideBar, {
    preferredSize: action ? 240 : 0,
    minSize: 0,
    visible: true, // Let it be draggable even when closed
  })

  useEffect(() => {
    if (action) {
      setRenderedAction(action)
    }
  }, [action])

  const onTransitionEnd = () => {
    if (!action) {
      setRenderedAction(undefined)
    }
  }

  const CurrentView = useMemo(
    () => viewActions.find((v) => v.name === renderedAction)?.View,
    [renderedAction],
  )

  return (
    <>
      {action && mobile && <Overlay onClick={() => setAction(undefined)} />}
      <div
        className={clsx(
          'SideBar bg-surface flex flex-col overflow-hidden transition-all duration-200 ease-in-out',
          mobile ? 'absolute inset-y-0 right-0 z-10' : '',
        )}
        style={{ width: mobile ? '75%' : size }}
        onTransitionEnd={onTransitionEnd}
      >
        {CurrentView && (
          <CurrentView
            name={t(`${renderedAction}.title`)}
            title={t(`${renderedAction}.title`)}
          />
        )}
      </div>
    </>
  )
}

interface ReaderProps extends ComponentProps<'div'> {}
const Reader: React.FC<ReaderProps> = ({
  className,
  ...props
}: ReaderProps) => {
  const { size } = useSplitViewItem(Reader, { visible: true })
  const [bg] = useBackground()

  const r = useReaderSnapshot()
  const readMode = r.focusedTab?.isBook

  return (
    <div
      className={clsx(
        'Reader flex-1 overflow-hidden',
        readMode || 'mb-12 sm:mb-0',
        bg,
      )}
      style={{
        transform: 'translateZ(0)',
        minWidth: 0,
        ...(size && { width: size }),
      }}
      {...props}
    />
  )
}
