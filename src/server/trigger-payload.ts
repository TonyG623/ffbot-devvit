/**
 * Parsing for trigger request bodies.
 *
 * These shapes ARE contracted: `@devvit/web/shared` re-exports
 * `OnCommentCreateRequest`, `OnCommentDeleteRequest` and `OnPostDeleteRequest`
 * from `@devvit/shared/types/triggers`. An earlier version of this file
 * reconstructed them by hand, on the mistaken belief that no types were
 * exported — they are named `On*Request` rather than after the proto messages,
 * which is why searching for the message names came up empty.
 *
 * What still needs care: these are TypeScript types over a JSON body, so
 * nothing validates them at runtime, and the JSON does not always match the
 * declared types — `createdAt` is typed `Date` but arrives as a number. So
 * every field is read defensively and a payload that is not what we expect
 * yields `undefined` rather than a throw.
 */
import type {
  OnCommentCreateRequest,
  OnCommentDeleteRequest,
  OnPostDeleteRequest,
} from '@devvit/web/shared'

/** The fields the counting rules actually need. */
export type ParsedComment = {
  commentId: string
  postId: string
  parentId: string
  author: string
  body: string
  permalink: string
  createdAtMs: number
  removed: boolean
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Devvit sends `t1_abc`; be tolerant of a bare id. */
function withPrefix(id: string, prefix: 't1_' | 't3_'): string {
  return id.startsWith(prefix) ? id : `${prefix}${id}`
}

/** Protobuf timestamps arrive as seconds or milliseconds depending on the hop. */
const YEAR_2001_MS = 1_000_000_000_000

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return n < YEAR_2001_MS ? n * 1000 : n
}

export function parseCommentCreate(raw: unknown): ParsedComment | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const event = raw as Partial<OnCommentCreateRequest>

  const comment = event.comment
  if (!comment) return undefined

  const commentId = str(comment.id)
  const parentId = str(comment.parentId)
  const postId = str(comment.postId) ?? str(event.post?.id)
  if (!commentId || !parentId || !postId) return undefined

  // The USERNAME comes from the sibling `author` object. `comment.author` is
  // typed as a string but carries the author's t2_ ID — confirmed against a
  // live payload, which held "t2_2mjbzpp4by". Reading it would put raw ids on
  // the leaderboards. Do not "simplify" this.
  const author = str(event.author?.name) ?? ''

  return {
    commentId: withPrefix(commentId, 't1_'),
    postId: withPrefix(postId, 't3_'),
    parentId,
    author,
    body: str(comment.body) ?? '',
    permalink: str(comment.permalink) ?? '',
    createdAtMs: toMillis(comment.createdAt),
    removed: Boolean(comment.deleted || comment.spam),
  }
}

/** The ids and provenance a delete event carries. */
export type ParsedDelete = {
  commentId?: string
  postId: string
  /** EventSource: 1 USER, 2 ADMIN, 3 MODERATOR. Logged, not acted on. */
  source?: number
  /** DeletionReason: 1 SPAM, 2 LEGAL, 3 OTHER, 4 UNKNOWN, 5 EXPLICIT. */
  reason?: number
}

export function parseCommentDelete(raw: unknown): ParsedDelete | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const event = raw as Partial<OnCommentDeleteRequest>
  const commentId = str(event.commentId)
  const postId = str(event.postId)
  if (!commentId || !postId) return undefined
  return {
    commentId: withPrefix(commentId, 't1_'),
    postId: withPrefix(postId, 't3_'),
    source: typeof event.source === 'number' ? event.source : undefined,
    reason: typeof event.reason === 'number' ? event.reason : undefined,
  }
}

export function parsePostDelete(raw: unknown): ParsedDelete | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const event = raw as Partial<OnPostDeleteRequest>
  const postId = str(event.postId)
  if (!postId) return undefined
  return {
    postId: withPrefix(postId, 't3_'),
    source: typeof event.source === 'number' ? event.source : undefined,
    reason: typeof event.reason === 'number' ? event.reason : undefined,
  }
}
