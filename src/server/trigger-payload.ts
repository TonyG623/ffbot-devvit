/**
 * Parsing for the onCommentCreate trigger body.
 *
 * `@devvit/web` does not export a type for what Devvit POSTs to a trigger
 * endpoint, so this is written against the protobuf definitions
 * (`CommentCreate` wrapping `CommentV2`, in
 * `@devvit/protos/types/devvit/reddit/v2alpha/commentv2.d.ts`) rather than
 * against anything guaranteed by the SDK's public API.
 *
 * That means the wire shape is INFERRED, not contracted. So this parser is
 * deliberately permissive: it accepts the event either wrapped in `{event: …}`
 * or bare, tolerates snake_case, and returns undefined rather than throwing on
 * anything it does not recognise. The caller logs the raw payload the first
 * time it sees one, so the real shape can be confirmed against a live event
 * instead of assumed.
 */

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

function pick(obj: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null) return obj[name]
  }
  return undefined
}

/** Devvit sends `t1_abc`; some payloads carry the bare id. Normalise. */
function withPrefix(id: string, prefix: 't1_' | 't3_'): string {
  return id.startsWith(prefix) ? id : `${prefix}${id}`
}

/**
 * Reddit timestamps arrive as seconds in protobuf and sometimes as
 * milliseconds after a JSON hop. Anything below this is clearly seconds.
 */
const YEAR_2001_MS = 1_000_000_000_000

function toMillis(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return Date.now()
  return n < YEAR_2001_MS ? n * 1000 : n
}

export function parseCommentCreate(raw: unknown): ParsedComment | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const root = raw as Record<string, unknown>

  // Accept {event: {...}}, {data: {...}} or the event itself.
  const envelope = (pick(root, 'event', 'data') ?? root) as Record<
    string,
    unknown
  >
  const comment = pick(envelope, 'comment') as
    | Record<string, unknown>
    | undefined
  if (!comment) return undefined

  const commentId = str(pick(comment, 'id'))
  const parentId = str(pick(comment, 'parentId', 'parent_id'))
  const body = pick(comment, 'body')
  if (!commentId || !parentId) return undefined

  // postId can live on the comment or on the sibling post object.
  const post = pick(envelope, 'post') as Record<string, unknown> | undefined
  const postId =
    str(pick(comment, 'postId', 'post_id')) ??
    (post ? str(pick(post, 'id')) : undefined)
  if (!postId) return undefined

  // MUST come from the sibling `author` object, not from `comment.author`.
  // A live payload showed comment.author = "t2_2mjbzpp4by" -- a user ID, not a
  // username. Reading it would put raw t2_ ids on the leaderboards.
  const authorObj = pick(envelope, 'author') as
    | Record<string, unknown>
    | undefined
  const author =
    (authorObj ? str(pick(authorObj, 'name', 'username')) : undefined) ??
    str(pick(comment, 'author')) ??
    ''

  return {
    commentId: withPrefix(commentId, 't1_'),
    postId: withPrefix(postId, 't3_'),
    parentId,
    author,
    body: typeof body === 'string' ? body : '',
    permalink: str(pick(comment, 'permalink')) ?? '',
    createdAtMs: toMillis(
      pick(comment, 'createdAt', 'created_at', 'createdUtc'),
    ),
    removed: Boolean(pick(comment, 'deleted', 'spam')),
  }
}

/** The ids a delete event carries. Shape inferred the same way as above. */
export type ParsedDelete = {
  commentId?: string
  postId?: string
}

export function parseDelete(raw: unknown): ParsedDelete | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const root = raw as Record<string, unknown>
  const envelope = (pick(root, 'event', 'data') ?? root) as Record<
    string,
    unknown
  >

  // CommentDelete carries flat ids; PostDelete carries a postId. Some payloads
  // nest the objects instead, so accept either.
  const comment = pick(envelope, 'comment') as
    | Record<string, unknown>
    | undefined
  const post = pick(envelope, 'post') as Record<string, unknown> | undefined

  const commentId =
    str(pick(envelope, 'commentId', 'comment_id')) ??
    (comment ? str(pick(comment, 'id')) : undefined)
  const postId =
    str(pick(envelope, 'postId', 'post_id')) ??
    (post ? str(pick(post, 'id')) : undefined)

  if (!commentId && !postId) return undefined
  return {
    ...(commentId ? {commentId: withPrefix(commentId, 't1_')} : {}),
    ...(postId ? {postId: withPrefix(postId, 't3_')} : {}),
  }
}
