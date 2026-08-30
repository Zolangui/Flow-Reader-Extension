import { webcrypto } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createSourceNodeSignature,
  createSourceTreeAddress,
  formatSourceTreePath,
  getSourceTreeRoot,
  resolveSourceTreeAddress,
  SOURCE_TREE_MODEL_VERSION,
  walkSourceTree,
} from '../src/source-tree'

import { parseXML } from './helpers'

function sourceDocument(body = ''): Document {
  return parseXML(
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>head</title></head><body>${body}</body></html>`,
    'application/xhtml+xml',
  )
}

describe('Shared Source Addressing', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto as unknown as Crypto))
  afterAll(() => vi.unstubAllGlobals())

  it('selects a namespaced XHTML body and addresses it as the root', () => {
    const document = sourceDocument('<p>Content</p>')
    const root = getSourceTreeRoot(document)
    const address = createSourceTreeAddress(document, root, 3)

    expect(root.localName).toBe('body')
    expect(address).toEqual({
      sourceModelVersion: SOURCE_TREE_MODEL_VERSION,
      spineIndex: 3,
      nodeKind: 'element',
      sourcePath: [],
    })
    expect(formatSourceTreePath(address.sourcePath)).toBe('root')
    expect(resolveSourceTreeAddress(document, address, 3)).toBe(root)
  })

  it('uses actual childNodes indexes including comments and processing instructions', () => {
    const document = sourceDocument()
    const root = getSourceTreeRoot(document)
    const comment = document.createComment('occupies index zero')
    const whitespace = document.createTextNode('  ')
    const paragraph = document.createElementNS(
      'http://www.w3.org/1999/xhtml',
      'p',
    )
    const empty = document.createTextNode('')
    const paragraphText = document.createTextNode('text')
    paragraph.append(empty, paragraphText)
    const instruction = document.createProcessingInstruction('lumen', 'test')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    root.append(comment, whitespace, paragraph, instruction, svg)

    const visits: { kind: string; path: string; value?: string }[] = []
    walkSourceTree(document, ({ node, nodeKind, sourcePath }) => {
      visits.push({
        kind: nodeKind,
        path: formatSourceTreePath(sourcePath),
        ...(nodeKind === 'text' ? { value: (node as Text).data } : {}),
      })
    })

    expect(visits).toEqual([
      { kind: 'element', path: 'root' },
      { kind: 'text', path: '1', value: '  ' },
      { kind: 'element', path: '2' },
      { kind: 'text', path: '2.0', value: '' },
      { kind: 'text', path: '2.1', value: 'text' },
      { kind: 'element', path: '4' },
    ])

    const textAddress = createSourceTreeAddress(document, paragraphText, 1)
    const svgAddress = createSourceTreeAddress(document, svg, 1)
    expect(textAddress.sourcePath).toEqual([2, 1])
    expect(svgAddress.sourcePath).toEqual([4])
    expect(resolveSourceTreeAddress(document, textAddress, 1)).toBe(
      paragraphText,
    )
    expect(resolveSourceTreeAddress(document, svgAddress, 1)).toBe(svg)
    expect(() => createSourceTreeAddress(document, comment, 1)).toThrow(
      TypeError,
    )
  })

  it('fails closed for stale paths, kinds, versions, and spine occurrences', () => {
    const document = sourceDocument('<p>same resource</p>')
    const text = getSourceTreeRoot(document).querySelector('p')!.firstChild!
    const firstOccurrence = createSourceTreeAddress(document, text, 0)
    const duplicateOccurrence = createSourceTreeAddress(document, text, 2)

    expect(firstOccurrence.sourcePath).toEqual(duplicateOccurrence.sourcePath)
    expect(firstOccurrence.spineIndex).not.toBe(duplicateOccurrence.spineIndex)
    expect(
      resolveSourceTreeAddress(document, firstOccurrence, 2),
    ).toBeUndefined()
    expect(resolveSourceTreeAddress(document, duplicateOccurrence, 2)).toBe(
      text,
    )
    expect(
      resolveSourceTreeAddress(
        document,
        { ...duplicateOccurrence, nodeKind: 'element' },
        2,
      ),
    ).toBeUndefined()
    expect(
      resolveSourceTreeAddress(
        document,
        { ...duplicateOccurrence, sourceModelVersion: 999 as never },
        2,
      ),
    ).toBeUndefined()
    expect(
      resolveSourceTreeAddress(
        document,
        { ...duplicateOccurrence, sourcePath: [99] },
        2,
      ),
    ).toBeUndefined()
  })

  it('rejects nodes outside the selected root and invalid occurrence indexes', () => {
    const document = sourceDocument('<p>body</p>')
    const title = document.querySelector('title')!

    expect(() => createSourceTreeAddress(document, title, 0)).toThrow(
      RangeError,
    )
    expect(() =>
      createSourceTreeAddress(document, getSourceTreeRoot(document), -1),
    ).toThrow(RangeError)
  })

  it('stops a bounded walk without visiting later siblings', () => {
    const document = sourceDocument('<p>one</p><p>two</p><p>three</p>')
    const paths: string[] = []
    walkSourceTree(document, ({ sourcePath }) => {
      paths.push(formatSourceTreePath(sourcePath))
      if (paths.length === 3) return 'stop'
    })

    expect(paths).toHaveLength(3)
    expect(paths).not.toContain('2')
  })

  it('projects only genuinely one-child renderer wrappers onto source slots', () => {
    const document = sourceDocument(
      '<table><tbody><tr><td>cell</td></tr></tbody></table>',
    )
    const root = getSourceTreeRoot(document)
    const table = root.querySelector('table')!
    const wrapper = document.createElementNS(
      'http://www.w3.org/1999/xhtml',
      'div',
    )
    root.insertBefore(wrapper, table)
    wrapper.appendChild(table)
    const transparent = (element: Element) => element === wrapper

    expect(
      createSourceTreeAddress(document, table, 0, {
        isTransparentContainer: transparent,
      }).sourcePath,
    ).toEqual([0])

    wrapper.appendChild(
      document.createElementNS('http://www.w3.org/1999/xhtml', 'span'),
    )
    expect(
      createSourceTreeAddress(document, table, 0, {
        isTransparentContainer: transparent,
      }).sourcePath,
    ).toEqual([0, 0])
  })

  it('signs exact source nodes while ignoring only Lumen-owned attributes', async () => {
    const first = sourceDocument('<p class="lead" title="x">Text</p>')
    const reordered = sourceDocument(
      '<p title="x" class="lead" data-lumen-probe="1">Text</p>',
    )
    const changed = sourceDocument('<p class="lead" title="x">Texts</p>')
    const firstElement = getSourceTreeRoot(first).querySelector('p')!
    const reorderedElement = getSourceTreeRoot(reordered).querySelector('p')!
    const changedElement = getSourceTreeRoot(changed).querySelector('p')!

    expect(await createSourceNodeSignature(firstElement)).toBe(
      await createSourceNodeSignature(reorderedElement),
    )
    expect(
      await createSourceNodeSignature(firstElement.firstChild as Text),
    ).not.toBe(
      await createSourceNodeSignature(changedElement.firstChild as Text),
    )
    changedElement.appendChild(changed.createComment('new child'))
    expect(await createSourceNodeSignature(firstElement)).not.toBe(
      await createSourceNodeSignature(changedElement),
    )
  })
})
