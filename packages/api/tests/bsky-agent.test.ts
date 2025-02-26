import {
  CloseFn,
  runTestServer,
  TestServerInfo,
} from '@atproto/pds/tests/_util'
import { BskyAgent, ComAtprotoRepoPutRecord, AppBskyActorProfile } from '..'

describe('agent', () => {
  let server: TestServerInfo
  let close: CloseFn

  beforeAll(async () => {
    server = await runTestServer({
      dbPostgresSchema: 'bsky_agent',
    })
    close = server.close
  })

  afterAll(async () => {
    await close()
  })

  it('upsertProfile correctly creates and updates profiles.', async () => {
    const agent = new BskyAgent({ service: server.url })

    await agent.createAccount({
      handle: 'user1.test',
      email: 'user1@test.com',
      password: 'password',
    })

    const profile1 = await agent.getProfile({ actor: agent.session?.did || '' })
    expect(profile1.data.displayName).toBeFalsy()

    await agent.upsertProfile((existing) => {
      expect(existing).toBeFalsy()
      return {
        displayName: 'Bob',
      }
    })

    const profile2 = await agent.getProfile({ actor: agent.session?.did || '' })
    expect(profile2.data.displayName).toBe('Bob')

    await agent.upsertProfile((existing) => {
      expect(existing).toBeTruthy()
      return {
        displayName: existing?.displayName?.toUpperCase(),
      }
    })

    const profile3 = await agent.getProfile({ actor: agent.session?.did || '' })
    expect(profile3.data.displayName).toBe('BOB')
  })

  it('upsertProfile correctly handles CAS failures.', async () => {
    const agent = new BskyAgent({ service: server.url })

    await agent.createAccount({
      handle: 'user2.test',
      email: 'user2@test.com',
      password: 'password',
    })

    const profile1 = await agent.getProfile({ actor: agent.session?.did || '' })
    expect(profile1.data.displayName).toBeFalsy()

    let hasConflicted = false
    let ranTwice = false
    await agent.upsertProfile(async (existing) => {
      if (!hasConflicted) {
        await agent.com.atproto.repo.putRecord({
          repo: agent.session?.did || '',
          collection: 'app.bsky.actor.profile',
          rkey: 'self',
          record: {
            $type: 'app.bsky.actor.profile',
            displayName: String(Math.random()),
          },
        })
        hasConflicted = true
      } else {
        ranTwice = true
      }
      return {
        displayName: 'Bob',
      }
    })
    expect(ranTwice).toBe(true)

    const profile2 = await agent.getProfile({ actor: agent.session?.did || '' })
    expect(profile2.data.displayName).toBe('Bob')
  })

  it('upsertProfile wont endlessly retry CAS failures.', async () => {
    const agent = new BskyAgent({ service: server.url })

    await agent.createAccount({
      handle: 'user3.test',
      email: 'user3@test.com',
      password: 'password',
    })

    const profile1 = await agent.getProfile({ actor: agent.session?.did || '' })
    expect(profile1.data.displayName).toBeFalsy()

    const p = agent.upsertProfile(async (existing) => {
      await agent.com.atproto.repo.putRecord({
        repo: agent.session?.did || '',
        collection: 'app.bsky.actor.profile',
        rkey: 'self',
        record: {
          $type: 'app.bsky.actor.profile',
          displayName: String(Math.random()),
        },
      })
      return {
        displayName: 'Bob',
      }
    })
    await expect(p).rejects.toThrow(ComAtprotoRepoPutRecord.InvalidSwapError)
  })

  it('upsertProfile validates the record.', async () => {
    const agent = new BskyAgent({ service: server.url })

    await agent.createAccount({
      handle: 'user4.test',
      email: 'user4@test.com',
      password: 'password',
    })

    const p = agent.upsertProfile((existing) => {
      return {
        displayName: { string: 'Bob' },
      } as unknown as AppBskyActorProfile.Record
    })
    await expect(p).rejects.toThrow('Record/displayName must be a string')
  })

  describe('app', () => {
    it('should retrieve the api app', () => {
      const agent = new BskyAgent({ service: server.url })
      expect(agent.app).toBe(agent.api.app)
    })
  })

  describe('post', () => {
    it('should throw if no session', async () => {
      const agent = new BskyAgent({ service: server.url })
      await expect(agent.post({ text: 'foo' })).rejects.toThrow('Not logged in')
    })
  })

  describe('deletePost', () => {
    it('should throw if no session', async () => {
      const agent = new BskyAgent({ service: server.url })
      await expect(agent.deletePost('foo')).rejects.toThrow('Not logged in')
    })
  })

  describe('like', () => {
    it('should throw if no session', async () => {
      const agent = new BskyAgent({ service: server.url })
      await expect(agent.like('foo', 'bar')).rejects.toThrow('Not logged in')
    })
  })

  describe('deleteLike', () => {
    it('should throw if no session', async () => {
      const agent = new BskyAgent({ service: server.url })
      await expect(agent.deleteLike('foo')).rejects.toThrow('Not logged in')
    })
  })

  describe('repost', () => {
    it('should throw if no session', async () => {
      const agent = new BskyAgent({ service: server.url })
      await expect(agent.repost('foo', 'bar')).rejects.toThrow('Not logged in')
    })
  })

  describe('deleteRepost', () => {
    it('should throw if no session', async () => {
      const agent = new BskyAgent({ service: server.url })
      await expect(agent.deleteRepost('foo')).rejects.toThrow('Not logged in')
    })
  })

  describe('follow', () => {
    it('should throw if no session', async () => {
      const agent = new BskyAgent({ service: server.url })
      await expect(agent.follow('foo')).rejects.toThrow('Not logged in')
    })
  })

  describe('deleteFollow', () => {
    it('should throw if no session', async () => {
      const agent = new BskyAgent({ service: server.url })
      await expect(agent.deleteFollow('foo')).rejects.toThrow('Not logged in')
    })
  })

  describe('preferences methods', () => {
    it('gets and sets preferences correctly', async () => {
      const agent = new BskyAgent({ service: server.url })

      await agent.createAccount({
        handle: 'user5.test',
        email: 'user5@test.com',
        password: 'password',
      })

      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: { pinned: undefined, saved: undefined },
        adultContentEnabled: false,
        contentLabels: {},
        birthDate: undefined,
      })

      await agent.setAdultContentEnabled(true)
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: { pinned: undefined, saved: undefined },
        adultContentEnabled: true,
        contentLabels: {},
        birthDate: undefined,
      })

      await agent.setAdultContentEnabled(false)
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: { pinned: undefined, saved: undefined },
        adultContentEnabled: false,
        contentLabels: {},
        birthDate: undefined,
      })

      await agent.setContentLabelPref('impersonation', 'warn')
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: { pinned: undefined, saved: undefined },
        adultContentEnabled: false,
        contentLabels: {
          impersonation: 'warn',
        },
        birthDate: undefined,
      })

      await agent.setContentLabelPref('spam', 'show') // will convert to 'ignore'
      await agent.setContentLabelPref('impersonation', 'hide')
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: { pinned: undefined, saved: undefined },
        adultContentEnabled: false,
        contentLabels: {
          impersonation: 'hide',
          spam: 'ignore',
        },
        birthDate: undefined,
      })

      await agent.addSavedFeed('at://bob.com/app.bsky.feed.generator/fake')
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: [],
          saved: ['at://bob.com/app.bsky.feed.generator/fake'],
        },
        adultContentEnabled: false,
        contentLabels: {
          impersonation: 'hide',
          spam: 'ignore',
        },
        birthDate: undefined,
      })

      await agent.addPinnedFeed('at://bob.com/app.bsky.feed.generator/fake')
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: ['at://bob.com/app.bsky.feed.generator/fake'],
          saved: ['at://bob.com/app.bsky.feed.generator/fake'],
        },
        adultContentEnabled: false,
        contentLabels: {
          impersonation: 'hide',
          spam: 'ignore',
        },
        birthDate: undefined,
      })

      await agent.removePinnedFeed('at://bob.com/app.bsky.feed.generator/fake')
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: [],
          saved: ['at://bob.com/app.bsky.feed.generator/fake'],
        },
        adultContentEnabled: false,
        contentLabels: {
          impersonation: 'hide',
          spam: 'ignore',
        },
        birthDate: undefined,
      })

      await agent.removeSavedFeed('at://bob.com/app.bsky.feed.generator/fake')
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: [],
          saved: [],
        },
        adultContentEnabled: false,
        contentLabels: {
          impersonation: 'hide',
          spam: 'ignore',
        },
        birthDate: undefined,
      })

      await agent.addPinnedFeed('at://bob.com/app.bsky.feed.generator/fake')
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: ['at://bob.com/app.bsky.feed.generator/fake'],
          saved: ['at://bob.com/app.bsky.feed.generator/fake'],
        },
        adultContentEnabled: false,
        contentLabels: {
          impersonation: 'hide',
          spam: 'ignore',
        },
        birthDate: undefined,
      })

      await agent.addPinnedFeed('at://bob.com/app.bsky.feed.generator/fake2')
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: [
            'at://bob.com/app.bsky.feed.generator/fake',
            'at://bob.com/app.bsky.feed.generator/fake2',
          ],
          saved: [
            'at://bob.com/app.bsky.feed.generator/fake',
            'at://bob.com/app.bsky.feed.generator/fake2',
          ],
        },
        adultContentEnabled: false,
        contentLabels: {
          impersonation: 'hide',
          spam: 'ignore',
        },
        birthDate: undefined,
      })

      await agent.removeSavedFeed('at://bob.com/app.bsky.feed.generator/fake')
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: ['at://bob.com/app.bsky.feed.generator/fake2'],
          saved: ['at://bob.com/app.bsky.feed.generator/fake2'],
        },
        adultContentEnabled: false,
        contentLabels: {
          impersonation: 'hide',
          spam: 'ignore',
        },
        birthDate: undefined,
      })

      await agent.setPersonalDetails({ birthDate: '2023-09-11T18:05:42.556Z' })
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: ['at://bob.com/app.bsky.feed.generator/fake2'],
          saved: ['at://bob.com/app.bsky.feed.generator/fake2'],
        },
        adultContentEnabled: false,
        contentLabels: {
          impersonation: 'hide',
          spam: 'ignore',
        },
        birthDate: new Date('2023-09-11T18:05:42.556Z'),
      })
    })

    it('resolves duplicates correctly', async () => {
      const agent = new BskyAgent({ service: server.url })

      await agent.createAccount({
        handle: 'user6.test',
        email: 'user6@test.com',
        password: 'password',
      })

      await agent.app.bsky.actor.putPreferences({
        preferences: [
          {
            $type: 'app.bsky.actor.defs#contentLabelPref',
            label: 'nsfw',
            visibility: 'show',
          },
          {
            $type: 'app.bsky.actor.defs#contentLabelPref',
            label: 'nsfw',
            visibility: 'hide',
          },
          {
            $type: 'app.bsky.actor.defs#contentLabelPref',
            label: 'nsfw',
            visibility: 'show',
          },
          {
            $type: 'app.bsky.actor.defs#contentLabelPref',
            label: 'nsfw',
            visibility: 'warn',
          },
          {
            $type: 'app.bsky.actor.defs#adultContentPref',
            enabled: true,
          },
          {
            $type: 'app.bsky.actor.defs#adultContentPref',
            enabled: false,
          },
          {
            $type: 'app.bsky.actor.defs#adultContentPref',
            enabled: true,
          },
          {
            $type: 'app.bsky.actor.defs#savedFeedsPref',
            pinned: [
              'at://bob.com/app.bsky.feed.generator/fake',
              'at://bob.com/app.bsky.feed.generator/fake2',
            ],
            saved: [
              'at://bob.com/app.bsky.feed.generator/fake',
              'at://bob.com/app.bsky.feed.generator/fake2',
            ],
          },
          {
            $type: 'app.bsky.actor.defs#savedFeedsPref',
            pinned: [],
            saved: [],
          },
          {
            $type: 'app.bsky.actor.defs#personalDetailsPref',
            birthDate: '2023-09-11T18:05:42.556Z',
          },
          {
            $type: 'app.bsky.actor.defs#personalDetailsPref',
            birthDate: '2021-09-11T18:05:42.556Z',
          },
        ],
      })
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: [],
          saved: [],
        },
        adultContentEnabled: true,
        contentLabels: {
          nsfw: 'warn',
        },
        birthDate: new Date('2021-09-11T18:05:42.556Z'),
      })

      await agent.setAdultContentEnabled(false)
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: [],
          saved: [],
        },
        adultContentEnabled: false,
        contentLabels: {
          nsfw: 'warn',
        },
        birthDate: new Date('2021-09-11T18:05:42.556Z'),
      })

      await agent.setContentLabelPref('nsfw', 'hide')
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: [],
          saved: [],
        },
        adultContentEnabled: false,
        contentLabels: {
          nsfw: 'hide',
        },
        birthDate: new Date('2021-09-11T18:05:42.556Z'),
      })

      await agent.addPinnedFeed('at://bob.com/app.bsky.feed.generator/fake')
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: ['at://bob.com/app.bsky.feed.generator/fake'],
          saved: ['at://bob.com/app.bsky.feed.generator/fake'],
        },
        adultContentEnabled: false,
        contentLabels: {
          nsfw: 'hide',
        },
        birthDate: new Date('2021-09-11T18:05:42.556Z'),
      })

      await agent.setPersonalDetails({ birthDate: '2023-09-11T18:05:42.556Z' })
      await expect(agent.getPreferences()).resolves.toStrictEqual({
        feeds: {
          pinned: ['at://bob.com/app.bsky.feed.generator/fake'],
          saved: ['at://bob.com/app.bsky.feed.generator/fake'],
        },
        adultContentEnabled: false,
        contentLabels: {
          nsfw: 'hide',
        },
        birthDate: new Date('2023-09-11T18:05:42.556Z'),
      })

      const res = await agent.app.bsky.actor.getPreferences()
      await expect(res.data.preferences).toStrictEqual([
        {
          $type: 'app.bsky.actor.defs#adultContentPref',
          enabled: false,
        },
        {
          $type: 'app.bsky.actor.defs#contentLabelPref',
          label: 'nsfw',
          visibility: 'hide',
        },
        {
          $type: 'app.bsky.actor.defs#savedFeedsPref',
          pinned: ['at://bob.com/app.bsky.feed.generator/fake'],
          saved: ['at://bob.com/app.bsky.feed.generator/fake'],
        },
        {
          $type: 'app.bsky.actor.defs#personalDetailsPref',
          birthDate: '2023-09-11T18:05:42.556Z',
        },
      ])
    })
  })
})
