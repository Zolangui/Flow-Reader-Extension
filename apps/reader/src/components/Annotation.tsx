import { useEffect } from 'react'
import { useSnapshot } from 'valtio'

import { colorMap, Annotation as IAnnotation } from '../annotation'
import { useSetAction } from '../hooks'
import { BookTab, compareHref } from '../models'

interface FindMatchProps {
  tab: BookTab
}
const FindMatches: React.FC<FindMatchProps> = ({ tab }) => {
  const setAction = useSetAction()
  const { rendition, results, currentHref } = useSnapshot(tab)

  useEffect(() => {
    const result = results?.find((r) => compareHref(currentHref, r.id))

    const matches = result?.subitems
    matches?.forEach((m) => {
      try {
        const h = rendition?.annotations.highlight(
          m.cfi!,
          undefined,
          undefined,
          undefined,
          {
            // tailwind yellow-500
            fill: 'rgba(234, 179, 8, 0.3)',
            'fill-opacity': 'unset',
          },
        )

        const g = (h?.mark as { element?: SVGGElement } | undefined)?.element
        g?.addEventListener('click', (event) => {
          event.stopPropagation()
        })
      } catch (error) {
        // ignore matched text in `<title>`
      }
    })

    return () => {
      matches?.forEach((m) => {
        rendition?.annotations.remove(m.cfi!, 'highlight')
      })
    }
  }, [currentHref, rendition?.annotations, results, setAction])

  return null
}

interface AnnotationProps {
  tab: BookTab
  annotation: IAnnotation
}
const Annotation: React.FC<AnnotationProps> = ({ tab, annotation }) => {
  const { rendition } = useSnapshot(tab)

  useEffect(() => {
    const h = rendition?.annotations[annotation.type](
      annotation.cfi,
      undefined,
      undefined,
      undefined,
      {
        fill: colorMap[annotation.color],
        'fill-opacity': '0.5',
      },
    )

    const g = (h?.mark as { element?: SVGGElement } | undefined)?.element

    // `<rect>` should be reserved to response `click`
    g?.addEventListener('click', (event) => {
      event.stopPropagation()
      tab.setAnnotationRange(annotation.cfi)
    })

    return () => {
      rendition?.annotations.remove(annotation.cfi, annotation.type)
    }
  }, [
    annotation.cfi,
    annotation.color,
    annotation.type,
    rendition?.annotations,
    tab,
  ])

  return null
}

interface AnnotationsProps {
  tab: BookTab
}
export const Annotations: React.FC<AnnotationsProps> = ({ tab }) => {
  const { book, section } = useSnapshot(tab)

  return (
    <>
      <FindMatches tab={tab} />
      {/* with `key`, react will mount/unmount it automatically */}
      {book.annotations
        // seems to fix annotation flash when executing `next()` and `display()`
        .filter((a) => a.spine.index === section?.index)
        .map((annotation) => (
          <Annotation key={annotation.id} tab={tab} annotation={annotation} />
        ))}
    </>
  )
}
