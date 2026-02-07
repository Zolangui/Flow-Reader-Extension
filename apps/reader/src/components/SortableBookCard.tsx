import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import React from 'react'

import { BookCard, BookCardProps } from './BookCard'

interface SortableBookCardProps extends BookCardProps {
  id: string
  disabled?: boolean
  isIndexed?: boolean
}

export const SortableBookCard: React.FC<SortableBookCardProps> = ({
  id,
  disabled,
  isIndexed,
  ...props
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 'auto',
    position: 'relative' as const,
    outline: 'none',
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <BookCard {...props} isIndexed={isIndexed} />
      {/* Visual indicator for drag mode (optional, can be refined) */}
      {!disabled && (
        <div className="ring-primary/20 absolute inset-0 z-0 hidden rounded-xl ring-2 hover:block" />
      )}
    </div>
  )
}
