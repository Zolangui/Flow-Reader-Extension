import ePub from '@flow/epubjs'

/** Parse an EPUB without importing the persistence or synchronization layers. */
export async function fileToEpub(file: File) {
  return ePub(await file.arrayBuffer())
}

/** Read a Blob/FileReader result through a small environment-facing adapter. */
export function readBlob(fn: (reader: FileReader) => void) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(reader.result as string))
    reader.addEventListener('error', () =>
      reject(reader.error ?? new Error('Unable to read blob')),
    )
    reader.addEventListener('abort', () =>
      reject(new DOMException('Blob read was aborted', 'AbortError')),
    )
    fn(reader)
  })
}
