import { InvalidRequestError } from '@atproto/xrpc-server'
import { AtUri } from '@atproto/syntax'
import { Server } from '../../../../lexicon'
import {
  BlockedPost,
  NotFoundPost,
  ThreadViewPost,
  isNotFoundPost,
  isThreadViewPost,
} from '../../../../lexicon/types/app/bsky/feed/defs'
import { Record as PostRecord } from '../../../../lexicon/types/app/bsky/feed/post'
import { Record as ThreadgateRecord } from '../../../../lexicon/types/app/bsky/feed/threadgate'
import { QueryParams } from '../../../../lexicon/types/app/bsky/feed/getPostThread'
import AppContext from '../../../../context'
import {
  FeedService,
  FeedRow,
  FeedHydrationState,
  PostInfo,
} from '../../../../services/feed'
import {
  getAncestorsAndSelfQb,
  getDescendentsQb,
} from '../../../../services/util/post'
import { Database } from '../../../../db'
import DatabaseSchema from '../../../../db/database-schema'
import { setRepoRev } from '../../../util'
import { ActorInfoMap, ActorService } from '../../../../services/actor'
import { violatesThreadGate } from '../../../../services/feed/util'
import { createPipeline, noRules } from '../../../../pipeline'

export default function (server: Server, ctx: AppContext) {
  const getPostThread = createPipeline(
    skeleton,
    hydration,
    noRules, // handled in presentation: 3p block-violating replies are turned to #blockedPost, viewer blocks turned to #notFoundPost.
    presentation,
  )
  server.app.bsky.feed.getPostThread({
    auth: ctx.authOptionalVerifier,
    handler: async ({ params, auth, res }) => {
      const viewer = auth.credentials.did
      const db = ctx.db.getReplica('thread')
      const feedService = ctx.services.feed(db)
      const actorService = ctx.services.actor(db)

      const [result, repoRev] = await Promise.allSettled([
        getPostThread({ ...params, viewer }, { db, feedService, actorService }),
        actorService.getRepoRev(viewer),
      ])

      if (repoRev.status === 'fulfilled') {
        setRepoRev(res, repoRev.value)
      }
      if (result.status === 'rejected') {
        throw result.reason
      }

      return {
        encoding: 'application/json',
        body: result.value,
      }
    },
  })
}

const skeleton = async (params: Params, ctx: Context) => {
  const threadData = await getThreadData(params, ctx)
  if (!threadData) {
    throw new InvalidRequestError(`Post not found: ${params.uri}`, 'NotFound')
  }
  return { params, threadData }
}

const hydration = async (state: SkeletonState, ctx: Context) => {
  const { feedService } = ctx
  const {
    threadData,
    params: { viewer },
  } = state
  const relevant = getRelevantIds(threadData)
  const hydrated = await feedService.feedHydration({ ...relevant, viewer })
  // check root reply interaction rules
  const anchorPostUri = threadData.post.postUri
  const rootUri = threadData.post.replyRoot || anchorPostUri
  const anchor = hydrated.posts[anchorPostUri]
  const root = hydrated.posts[rootUri]
  const gate = hydrated.threadgates[rootUri]?.record
  const viewerCanReply = await checkViewerCanReply(
    ctx.db.db,
    anchor ?? null,
    viewer,
    new AtUri(rootUri).host,
    (root?.record ?? null) as PostRecord | null,
    gate ?? null,
  )
  return { ...state, ...hydrated, viewerCanReply }
}

const presentation = (state: HydrationState, ctx: Context) => {
  const { params, profiles } = state
  const { actorService } = ctx
  const actors = actorService.views.profileBasicPresentation(
    Object.keys(profiles),
    state,
    { viewer: params.viewer },
  )
  const thread = composeThread(state.threadData, actors, state, ctx)
  if (isNotFoundPost(thread)) {
    // @TODO technically this could be returned as a NotFoundPost based on lexicon
    throw new InvalidRequestError(`Post not found: ${params.uri}`, 'NotFound')
  }
  if (isThreadViewPost(thread) && params.viewer) {
    thread.viewer = { canReply: state.viewerCanReply }
  }
  return { thread }
}

const composeThread = (
  threadData: PostThread,
  actors: ActorInfoMap,
  state: HydrationState,
  ctx: Context,
) => {
  const { feedService } = ctx
  const { posts, threadgates, embeds, blocks, labels, lists } = state

  const post = feedService.views.formatPostView(
    threadData.post.postUri,
    actors,
    posts,
    threadgates,
    embeds,
    labels,
    lists,
  )

  // replies that are invalid due to reply-gating:
  // a. may appear as the anchor post, but without any parent or replies.
  // b. may not appear anywhere else in the thread.
  const isAnchorPost = state.threadData.post.uri === threadData.post.postUri
  const info = posts[threadData.post.postUri]
  const badReply = !!info?.invalidReplyRoot || !!info?.violatesThreadGate
  const omitBadReply = !isAnchorPost && badReply

  if (!post || blocks[post.uri]?.reply || omitBadReply) {
    return {
      $type: 'app.bsky.feed.defs#notFoundPost',
      uri: threadData.post.postUri,
      notFound: true,
    }
  }

  if (post.author.viewer?.blocking || post.author.viewer?.blockedBy) {
    return {
      $type: 'app.bsky.feed.defs#blockedPost',
      uri: threadData.post.postUri,
      blocked: true,
      author: {
        did: post.author.did,
        viewer: post.author.viewer
          ? {
              blockedBy: post.author.viewer?.blockedBy,
              blocking: post.author.viewer?.blocking,
            }
          : undefined,
      },
    }
  }

  let parent
  if (threadData.parent && !badReply) {
    if (threadData.parent instanceof ParentNotFoundError) {
      parent = {
        $type: 'app.bsky.feed.defs#notFoundPost',
        uri: threadData.parent.uri,
        notFound: true,
      }
    } else {
      parent = composeThread(threadData.parent, actors, state, ctx)
    }
  }

  let replies: (ThreadViewPost | NotFoundPost | BlockedPost)[] | undefined
  if (threadData.replies && !badReply) {
    replies = threadData.replies.flatMap((reply) => {
      const thread = composeThread(reply, actors, state, ctx)
      // e.g. don't bother including #postNotFound reply placeholders for takedowns. either way matches api contract.
      const skip = []
      return isNotFoundPost(thread) ? skip : thread
    })
  }

  return {
    $type: 'app.bsky.feed.defs#threadViewPost',
    post,
    parent,
    replies,
  }
}

const getRelevantIds = (
  thread: PostThread,
): { dids: Set<string>; uris: Set<string> } => {
  const dids = new Set<string>()
  const uris = new Set<string>()
  if (thread.parent && !(thread.parent instanceof ParentNotFoundError)) {
    const fromParent = getRelevantIds(thread.parent)
    fromParent.dids.forEach((did) => dids.add(did))
    fromParent.uris.forEach((uri) => uris.add(uri))
  }
  if (thread.replies) {
    for (const reply of thread.replies) {
      const fromChild = getRelevantIds(reply)
      fromChild.dids.forEach((did) => dids.add(did))
      fromChild.uris.forEach((uri) => uris.add(uri))
    }
  }
  dids.add(thread.post.postAuthorDid)
  uris.add(thread.post.postUri)
  if (thread.post.replyRoot) {
    // ensure root is included for checking interactions
    uris.add(thread.post.replyRoot)
  }
  return { dids, uris }
}

const getThreadData = async (
  params: Params,
  ctx: Context,
): Promise<PostThread | null> => {
  const { db, feedService } = ctx
  const { uri, depth, parentHeight } = params

  const [parents, children] = await Promise.all([
    getAncestorsAndSelfQb(db.db, { uri, parentHeight })
      .selectFrom('ancestor')
      .innerJoin(
        feedService.selectPostQb().as('post'),
        'post.uri',
        'ancestor.uri',
      )
      .selectAll('post')
      .execute(),
    getDescendentsQb(db.db, { uri, depth })
      .selectFrom('descendent')
      .innerJoin(
        feedService.selectPostQb().as('post'),
        'post.uri',
        'descendent.uri',
      )
      .selectAll('post')
      .orderBy('sortAt', 'desc')
      .execute(),
  ])
  const parentsByUri = parents.reduce((acc, parent) => {
    return Object.assign(acc, { [parent.postUri]: parent })
  }, {} as Record<string, FeedRow>)
  const childrenByParentUri = children.reduce((acc, child) => {
    if (!child.replyParent) return acc
    acc[child.replyParent] ??= []
    acc[child.replyParent].push(child)
    return acc
  }, {} as Record<string, FeedRow[]>)
  const post = parentsByUri[uri]
  if (!post) return null
  return {
    post,
    parent: post.replyParent
      ? getParentData(parentsByUri, post.replyParent, parentHeight)
      : undefined,
    replies: getChildrenData(childrenByParentUri, uri, depth),
  }
}

const getParentData = (
  postsByUri: Record<string, FeedRow>,
  uri: string,
  depth: number,
): PostThread | ParentNotFoundError | undefined => {
  if (depth < 1) return undefined
  const post = postsByUri[uri]
  if (!post) return new ParentNotFoundError(uri)
  return {
    post,
    parent: post.replyParent
      ? getParentData(postsByUri, post.replyParent, depth - 1)
      : undefined,
    replies: [],
  }
}

const getChildrenData = (
  childrenByParentUri: Record<string, FeedRow[]>,
  uri: string,
  depth: number,
): PostThread[] | undefined => {
  if (depth === 0) return undefined
  const children = childrenByParentUri[uri] ?? []
  return children.map((row) => ({
    post: row,
    replies: getChildrenData(childrenByParentUri, row.postUri, depth - 1),
  }))
}

const checkViewerCanReply = async (
  db: DatabaseSchema,
  anchor: PostInfo | null,
  viewer: string | null,
  owner: string,
  root: PostRecord | null,
  threadgate: ThreadgateRecord | null,
) => {
  if (!viewer) return false
  if (anchor?.invalidReplyRoot || anchor?.violatesThreadGate) return false
  const viewerViolatesThreadGate = await violatesThreadGate(
    db,
    viewer,
    owner,
    root,
    threadgate,
  )
  return !viewerViolatesThreadGate
}

class ParentNotFoundError extends Error {
  constructor(public uri: string) {
    super(`Parent not found: ${uri}`)
  }
}

type PostThread = {
  post: FeedRow
  parent?: PostThread | ParentNotFoundError
  replies?: PostThread[]
}

type Context = {
  db: Database
  feedService: FeedService
  actorService: ActorService
}

type Params = QueryParams & { viewer: string | null }

type SkeletonState = {
  params: Params
  threadData: PostThread
}

type HydrationState = SkeletonState &
  FeedHydrationState & {
    viewerCanReply: boolean
  }
