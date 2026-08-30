import { Dropbox } from 'dropbox'
import { saveAs } from 'file-saver'
import JSZip from 'jszip'
import { destroyCookie, parseCookies, setCookie } from 'nookies'

import { BookRecord, db, mergeIncomingBookRecord } from './db'
import { readBlob } from './lib/epub-file'

export const mapToToken = {
  dropbox: 'dropbox-refresh-token',
}

export const OAUTH_SUCCESS_MESSAGE = 'oauth_success'

let dropboxClient: Dropbox | undefined

function getDropboxClient(): Dropbox {
  if (!dropboxClient) {
    dropboxClient = new Dropbox({
      clientId: process.env.NEXT_PUBLIC_DROPBOX_CLIENT_ID,
    })
    dropboxClient.auth.refreshAccessToken = () => ensureDropboxAccessToken()
  }
  return dropboxClient
}

const DROPBOX_AUTH_URL = 'https://www.dropbox.com/oauth2/authorize'
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token'

const isBrowser = () => typeof window !== 'undefined'
const isExtensionEnv = () => {
  const g = globalThis as any
  return !!(g?.chrome?.runtime?.id || g?.browser?.runtime?.id)
}

const getExtensionStorage = () => {
  const g = globalThis as any
  return g?.browser?.storage?.local || g?.chrome?.storage?.local || null
}

const storageGet = async (key: string) => {
  const store = getExtensionStorage()
  if (!store) return null
  if (store.get.length >= 2) {
    return new Promise<string | null>((resolve) => {
      store.get(key, (result: Record<string, string>) => {
        resolve(result?.[key] || null)
      })
    })
  }
  const result = await store.get(key)
  return result?.[key] || null
}

const storageSet = async (key: string, value: string) => {
  const store = getExtensionStorage()
  if (!store) return
  if (store.set.length >= 2) {
    return new Promise<void>((resolve) => {
      store.set({ [key]: value }, () => resolve())
    })
  }
  await store.set({ [key]: value })
}

const storageRemove = async (key: string) => {
  const store = getExtensionStorage()
  if (!store) return
  if (store.remove.length >= 2) {
    return new Promise<void>((resolve) => {
      store.remove(key, () => resolve())
    })
  }
  await store.remove(key)
}

export async function getDropboxRefreshToken(): Promise<string | null> {
  if (isExtensionEnv()) {
    return storageGet(mapToToken.dropbox)
  }
  const cookies = parseCookies()
  return cookies[mapToToken.dropbox] || null
}

export async function setDropboxRefreshToken(token: string): Promise<void> {
  if (isExtensionEnv()) {
    await storageSet(mapToToken.dropbox, token)
    return
  }
  if (!isBrowser()) return
  setCookie(null, mapToToken.dropbox, token, {
    maxAge: 365 * 24 * 60 * 60,
    path: '/',
  })
}

export async function clearDropboxRefreshToken(): Promise<void> {
  if (isExtensionEnv()) {
    await storageRemove(mapToToken.dropbox)
    return
  }
  if (!isBrowser()) return
  destroyCookie(null, mapToToken.dropbox, { path: '/' })
}

const base64UrlEncode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const sha256 = async (value: string) => {
  const data = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(hash)
}

const randomString = (length: number) => {
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)
  return base64UrlEncode(array)
}

const buildPkcePair = async () => {
  const verifier = randomString(64)
  const challenge = base64UrlEncode(await sha256(verifier))
  return { verifier, challenge }
}

const buildAuthUrl = (
  redirectUri: string,
  state: string,
  challenge: string,
) => {
  const clientId = process.env.NEXT_PUBLIC_DROPBOX_CLIENT_ID || ''
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    state,
  })
  return `${DROPBOX_AUTH_URL}?${params.toString()}`
}

const exchangeCodeForToken = async (
  code: string,
  verifier: string,
  redirectUri: string,
) => {
  const clientId = process.env.NEXT_PUBLIC_DROPBOX_CLIENT_ID || ''
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: clientId,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  })
  const res = await fetch(DROPBOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Dropbox token exchange falhou: ${text || res.status}`)
  }
  return res.json() as Promise<{
    access_token: string
    refresh_token?: string
    expires_in?: number
  }>
}

const refreshAccessTokenWithToken = async (refreshToken: string) => {
  const clientId = process.env.NEXT_PUBLIC_DROPBOX_CLIENT_ID || ''
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  })
  const res = await fetch(DROPBOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Dropbox refresh falhou: ${text || res.status}`)
  }
  return res.json() as Promise<{ access_token: string; expires_in?: number }>
}

export const canUseDropboxPkce = () => {
  const g = globalThis as any
  const identity = g?.browser?.identity || g?.chrome?.identity
  return !!identity?.launchWebAuthFlow && !!identity?.getRedirectURL
}

export async function authorizeDropboxWithPkce(): Promise<void> {
  if (!isBrowser()) throw new Error('Auth only available in browser')
  const g = globalThis as any
  const identity = g?.browser?.identity || g?.chrome?.identity
  if (!identity?.launchWebAuthFlow || !identity?.getRedirectURL) {
    throw new Error('PKCE not supported in this environment')
  }

  const redirectUri = identity.getRedirectURL('dropbox-auth')
  const state = randomString(16)
  const { verifier, challenge } = await buildPkcePair()
  const authUrl = buildAuthUrl(redirectUri, state, challenge)

  const launch = identity.launchWebAuthFlow.bind(identity)
  const redirect = await new Promise<string>((resolve, reject) => {
    if (launch.length >= 2) {
      launch({ url: authUrl, interactive: true }, (responseUrl: string) => {
        const lastErr = g?.chrome?.runtime?.lastError
        if (lastErr) return reject(lastErr)
        if (!responseUrl) return reject(new Error('No response url'))
        resolve(responseUrl)
      })
      return
    }
    const result = launch({ url: authUrl, interactive: true })
    if (result && typeof result.then === 'function') {
      result.then(resolve).catch(reject)
      return
    }
    reject(new Error('launchWebAuthFlow not supported'))
  })

  const parsed = new URL(redirect)
  const code = parsed.searchParams.get('code')
  const returnedState = parsed.searchParams.get('state')
  if (!code || returnedState !== state) {
    throw new Error('OAuth state mismatch')
  }

  const token = await exchangeCodeForToken(code, verifier, redirectUri)
  const refreshToken = token.refresh_token || (await getDropboxRefreshToken())
  if (!refreshToken) {
    throw new Error('Dropbox refresh token missing')
  }

  await setDropboxRefreshToken(refreshToken)
  const client = getDropboxClient()
  client.auth.setAccessToken(token.access_token)
  if (token.expires_in) {
    client.auth.setAccessTokenExpiresAt(
      new Date(Date.now() + token.expires_in * 1000),
    )
  }
}

export async function authorizeDropboxFallback(): Promise<void> {
  if (!isBrowser()) return
  const redirectUri = window.location.origin + '/api/callback/dropbox'
  const url = await getDropboxClient().auth.getAuthenticationUrl(
    redirectUri,
    JSON.stringify({ redirectUri }),
    'code',
    'offline',
  )
  window.open(url as string, '_blank')
}

export async function authorizeDropbox(): Promise<void> {
  if (canUseDropboxPkce()) {
    await authorizeDropboxWithPkce()
    return
  }
  if (isExtensionEnv()) {
    throw new Error('PKCE not available in this extension context')
  }
  await authorizeDropboxFallback()
}

let _refreshReq: Promise<void> | undefined
export async function ensureDropboxAccessToken(): Promise<void> {
  const client = getDropboxClient()
  const accessToken = client.auth.getAccessToken()
  const expiresAt = client.auth.getAccessTokenExpiresAt()
  const isValid =
    accessToken && (!expiresAt || Date.now() < Number(expiresAt) - 30_000)
  if (isValid) return

  _refreshReq ??= (async () => {
    const refreshToken = await getDropboxRefreshToken()
    if (!refreshToken) throw new Error('Dropbox not authorized')
    const token = await refreshAccessTokenWithToken(refreshToken)
    client.auth.setAccessToken(token.access_token)
    if (token.expires_in) {
      client.auth.setAccessTokenExpiresAt(
        new Date(Date.now() + token.expires_in * 1000),
      )
    }
  })().finally(() => {
    _refreshReq = undefined
  })

  await _refreshReq
}

interface SerializedBooks {
  version: number
  dbVersion?: number
  books: BookRecord[]
}

const VERSION = 2
export const DATA_FILENAME = 'data.json'

function serializeData(books?: BookRecord[]) {
  return JSON.stringify({
    version: VERSION,
    dbVersion: db?.verno,
    books,
  })
}

export class UnsupportedSyncDataVersionError extends Error {
  constructor(version: number) {
    super(`This Lumen version cannot safely read sync data version ${version}`)
    this.name = 'UnsupportedSyncDataVersionError'
  }
}

function isBookRecordLike(value: unknown): value is BookRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<BookRecord>
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.name === 'string' &&
    Array.isArray(record.annotations)
  )
}

export function deserializeData(text: string): BookRecord[] {
  const {
    version = 1,
    dbVersion,
    books = [],
  } = JSON.parse(text) as Partial<SerializedBooks>

  if (!Number.isInteger(version) || version < 1) {
    throw new Error('Invalid Lumen sync data version')
  }
  if (version > VERSION) {
    // Preserving an unknown object is not enough: an older client would later
    // overwrite it with semantics it does not understand. Fail closed and let
    // the newer client remain the source of truth.
    throw new UnsupportedSyncDataVersionError(version)
  }

  if (version < VERSION) {
    // v1 has no canonicalProgress field. It remains valid legacy data; a
    // missing field simply causes a lazy local canonical migration on open.
  }
  if (db && dbVersion !== undefined && dbVersion < db.verno) {
    // migrate `BookRecord`
  }

  return Array.isArray(books) ? books.filter(isBookRecordLike) : []
}

async function mergeIncomingBooks(books: BookRecord[]): Promise<void> {
  if (!db) return

  await db.transaction('rw', db.books, async () => {
    for (const incoming of books) {
      const local = await db.books.get(incoming.id)
      await db.books.put(mergeIncomingBookRecord(local, incoming))
    }
  })
}

export async function uploadData(books: BookRecord[]) {
  await ensureDropboxAccessToken()
  return getDropboxClient().filesUpload({
    path: `/${DATA_FILENAME}`,
    mode: { '.tag': 'overwrite' },
    contents: serializeData(books),
  })
}

let pendingBooksUpload: BookRecord[] | undefined
let booksUploadDrain: Promise<void> | undefined

function cloneBooksForUpload(books: BookRecord[]): BookRecord[] {
  // Dropbox receives JSON, so snapshot through the same representation now;
  // later Valtio/SWR mutations must not alter an already queued payload.
  return JSON.parse(JSON.stringify(books)) as BookRecord[]
}

/**
 * Coalesce full-book snapshots and upload them strictly in order. Fire-and-
 * forget uploads can otherwise finish B -> A and restore stale progress.
 */
export function queueBooksUpload(books: BookRecord[]): Promise<void> {
  pendingBooksUpload = cloneBooksForUpload(books)
  if (booksUploadDrain) return booksUploadDrain

  booksUploadDrain = (async () => {
    while (pendingBooksUpload) {
      const next = pendingBooksUpload
      pendingBooksUpload = undefined
      try {
        await uploadData(next)
      } catch (error) {
        // A later local change will enqueue the latest complete snapshot again.
        // Avoid an immediate infinite retry loop while still surfacing failure.
        console.warn('Unable to upload Lumen sync data:', error)
      }
    }
  })().finally(() => {
    booksUploadDrain = undefined
    if (pendingBooksUpload) void queueBooksUpload(pendingBooksUpload)
  })

  return booksUploadDrain
}

export const dropboxFilesFetcher = async (path: string) => {
  try {
    await ensureDropboxAccessToken()
  } catch {
    return []
  }
  return getDropboxClient()
    .filesListFolder({ path })
    .then((d) => d.result.entries)
}

export const dropboxBooksFetcher = async (path: string) => {
  try {
    await ensureDropboxAccessToken()
  } catch {
    return []
  }
  return getDropboxClient()
    .filesDownload({ path })
    .then((d) => {
      const blob: Blob = (d.result as any).fileBlob
      return readBlob((r) => r.readAsText(blob))
    })
    .then((d) => deserializeData(d))
}

export async function downloadDropboxFile(path: string) {
  await ensureDropboxAccessToken()
  return getDropboxClient().filesDownload({ path })
}

export async function pack() {
  const books = await db?.books.toArray()
  const covers = await db?.covers.toArray()
  const files = await db?.files.toArray()

  const zip = new JSZip()
  zip.file(DATA_FILENAME, serializeData(books))
  zip.file('covers.json', JSON.stringify(covers))

  const folder = zip.folder('files')
  files?.forEach((f) => folder?.file(f.file.name, f.file))

  const date = new Intl.DateTimeFormat('fr-CA').format().replaceAll('-', '')

  return zip.generateAsync({ type: 'blob' }).then((content) => {
    saveAs(content, `lumen_backup_${date}.zip`)
  })
}

export async function unpack(file: File) {
  const zip = new JSZip()
  await zip.loadAsync(file)

  const booksJSON = zip.file(DATA_FILENAME)
  const coversJSON = zip.file('covers.json')
  if (!booksJSON || !coversJSON) return

  const books = deserializeData(await booksJSON.async('text'))

  await mergeIncomingBooks(books)

  const coversText = await coversJSON.async('text')
  db?.covers.bulkPut(JSON.parse(coversText))

  const folder = zip.folder('files')
  folder?.forEach(async (_, f) => {
    const book = books.find((b) => `files/${b.name}` === f.name)
    if (!book) return

    const data = await f.async('blob')
    const file = new File([data], book.name)
    db?.files.put({ file, id: book.id })
  })
}
