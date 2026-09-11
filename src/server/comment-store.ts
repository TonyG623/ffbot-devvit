/**
 * Devvit-bound wrapper over the counting rules in comment-counting.ts.
 *
 * The rules live in that module and take a Redis handle explicitly, so they can
 * be tested against an in-memory fake. This file is the thin layer that binds
 * them to the real client — and the only thing in the pair that cannot be unit
 * tested, which is why it holds no logic.
 */
import {redis} from '@devvit/web/server'
import type {ThreadAccumulator} from '../shared/types.ts'
import type {IncomingComment} from './comment-counting.ts'
import * as counting from './comment-counting.ts'

export type {IncomingComment} from './comment-counting.ts'

const db = redis as unknown as counting.RedisLike

export const trackPost = (postId: string): Promise<void> =>
  counting.trackPost(db, postId)

export const isTracked = (postId: string): Promise<boolean> =>
  counting.isTracked(db, postId)

export const recordComment = (
  c: IncomingComment,
): Promise<
  'top-level' | 'direct-reply' | 'orphan-reply' | 'deeper-reply' | 'duplicate'
> => counting.recordComment(db, c)

export const markRemoved = (postId: string, commentId: string): Promise<void> =>
  counting.markRemoved(db, postId, commentId)

export const clearRemoved = (
  postId: string,
  commentId: string,
): Promise<void> => counting.clearRemoved(db, postId, commentId)

export const refreshTopLevel = (
  postId: string,
  commentId: string,
  author: string,
): Promise<boolean> => counting.refreshTopLevel(db, postId, commentId, author)

export const refreshReply = (
  postId: string,
  commentId: string,
  author: string,
  substantive: boolean,
): Promise<boolean> =>
  counting.refreshReply(db, postId, commentId, author, substantive)

export const pruneMissing = (
  postId: string,
  seen: Set<string>,
  cutoffSec: number,
): Promise<number> => counting.pruneMissing(db, postId, seen, cutoffSec)

export const markSeeded = (postId: string): Promise<void> =>
  counting.markSeeded(db, postId)

export const isSeeded = (postId: string): Promise<boolean> =>
  counting.isSeeded(db, postId)

export const readThreadState = (postId: string): Promise<ThreadAccumulator> =>
  counting.readThreadState(db, postId)

export const clearThreadState = (postId: string): Promise<void> =>
  counting.clearThreadState(db, postId)
