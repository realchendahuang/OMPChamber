import { describe, expect, test } from "bun:test"
import type { Session } from "@ompchamber/agent-protocol/domain-types"
import type { Event, Part, PermissionRequest, QuestionRequest, SessionStatus, SubagentSnapshot } from "@ompchamber/agent-protocol/domain-types"
import { applyDirectoryEvent } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"

function state(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    message: {},
    part: {},
    session_status: {},
    subagent: {},
    ...overrides,
  }
}

function deltaEvent(): Event {
  return {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "hello",
    },
  } as Event
}

function partUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

function topLevelSessionOnlyPartUpdatedEvent(): Event {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_1",
        messageID: "msg_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

function buildSession(title: string, time: Session["time"]): Session {
  return {
    id: "ses_1",
    title,
    time,
  } as Session
}

describe("applyDirectoryEvent", () => {
  test("returns typed materialization when delta arrives before parts", () => {
    const result = applyDirectoryEvent(state(), deltaEvent())

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("returns typed materialization when delta part is missing", () => {
    const result = applyDirectoryEvent(
      state({ part: { msg_1: [{ id: "prt_2", messageID: "msg_1", type: "text", text: "" } as Part] } }),
      deltaEvent(),
    )

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "missing-delta-part", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("applies part update and requests materialization when owning message is absent", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        reason: "missing-owning-message",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id and part message id for part update materialization", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, topLevelSessionOnlyPartUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        reason: "missing-owning-message",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id for delta materialization", () => {
    const result = applyDirectoryEvent(state(), {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
        field: "text",
        delta: "hello",
      },
    } as Event)

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("skips stale session.updated events so a newer title survives", () => {
    const draft = state({ session: [buildSession("New Title", { created: 1, updated: 20 })] })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: buildSession("Old Title", { created: 1, updated: 10 }),
      },
    } as Event)

    expect(result).toBe(false)
    expect(draft.session[0]?.title).toBe("New Title")
  })

  test("applies part update without materialization when owning message exists", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })
    const result = applyDirectoryEvent(draft, partUpdatedEvent())

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toBe(true)
  })

  test("skips duplicate session status events", () => {
    const draft = state()
    const busyStatus = { type: "busy" } as SessionStatus
    const event = {
      type: "session.status",
      properties: { sessionID: "ses_1", status: busyStatus },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session idle events", () => {
    const draft = state()
    const event = {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session error idle-state events", () => {
    const draft = state()
    const event = {
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("detects retry status metadata changes", () => {
    const draft = state({
      session_status: {
        ses_1: { type: "retry", attempt: 1, message: "rate limited", next: 10 } as SessionStatus,
      },
    })

    const event = {
      type: "session.status",
      properties: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: 20 } as SessionStatus,
      },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    expect((draft.session_status.ses_1 as Extract<SessionStatus, { type: "retry" }>).attempt).toBe(2)
  })

  test("updates permission request arrays immutably", () => {
    const initialPermissions = [
      { id: "perm_1", sessionID: "ses_1" } as PermissionRequest,
    ]
    const draft = state({ permission: { ses_1: initialPermissions } })

    applyDirectoryEvent(draft, {
      type: "permission.asked",
      properties: { id: "perm_2", sessionID: "ses_1" } as PermissionRequest,
    } as Event)

    expect(draft.permission.ses_1).not.toBe(initialPermissions)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_1", "perm_2"])

    const afterAsk = draft.permission.ses_1
    applyDirectoryEvent(draft, {
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: "perm_1" },
    } as Event)

    expect(draft.permission.ses_1).not.toBe(afterAsk)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_2"])
  })

  test("updates question request arrays immutably", () => {
    const initialQuestions = [
      { id: "ques_1", sessionID: "ses_1" } as QuestionRequest,
    ]
    const draft = state({ question: { ses_1: initialQuestions } })

    applyDirectoryEvent(draft, {
      type: "question.asked",
      properties: { id: "ques_2", sessionID: "ses_1" } as QuestionRequest,
    } as Event)

    expect(draft.question.ses_1).not.toBe(initialQuestions)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_1", "ques_2"])

    const afterAsk = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "ques_1" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterAsk)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_2"])

    const afterReply = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.rejected",
      properties: { sessionID: "ses_1", requestID: "ques_2" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterReply)
    expect(draft.question.ses_1).toEqual([])
  })

  test("upserts ompchamber:subagent snapshots per session", () => {
    const draft = state()
    const first: SubagentSnapshot = {
      id: "sub_1",
      agent: "explore",
      description: "Explore the codebase",
      status: "running",
    }

    const result = applyDirectoryEvent(draft, {
      type: "ompchamber:subagent",
      properties: { sessionID: "ses_1", subagent: first },
    } as Event)

    expect(result).toBe(true)
    expect(draft.subagent.ses_1).toEqual([first])

    const updated: SubagentSnapshot = {
      ...first,
      status: "completed",
      progress: { toolCalls: 3, elapsedMs: 1200 },
    }
    applyDirectoryEvent(draft, {
      type: "ompchamber:subagent",
      properties: { sessionID: "ses_1", subagent: updated },
    } as Event)

    expect(draft.subagent.ses_1).toEqual([updated])
    expect(draft.subagent.ses_1.length).toBe(1)

    applyDirectoryEvent(draft, {
      type: "ompchamber:subagent",
      properties: { sessionID: "ses_2", subagent: { id: "sub_2", agent: "oracle", status: "running" } },
    } as Event)

    expect(draft.subagent.ses_2.map((item) => item.id)).toEqual(["sub_2"])
    expect(draft.subagent.ses_1.map((item) => item.id)).toEqual(["sub_1"])
  })

  test("ignores ompchamber:subagent events without a valid snapshot", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, {
      type: "ompchamber:subagent",
      properties: { sessionID: "ses_1", subagent: { id: "", agent: "explore" } },
    } as Event)

    expect(result).toBe(false)
    expect(draft.subagent.ses_1).toEqual(undefined)
  })

  test("returns changed:false when the subagent snapshot is unchanged", () => {
    const snapshot: SubagentSnapshot = { id: "sub_1", agent: "explore", status: "running" }
    const draft = state({ subagent: { ses_1: [snapshot] } })

    const result = applyDirectoryEvent(draft, {
      type: "ompchamber:subagent",
      properties: { sessionID: "ses_1", subagent: snapshot },
    } as Event)

    expect(result).toBe(false)
  })

  test("appends ompchamber:command-output as a finished synthetic assistant message", () => {
    const draft = state({
      message: {
        ses_1: [
          { id: "msg_u1", sessionID: "ses_1", role: "user", time: { created: 1 } },
          { id: "msg_a1", sessionID: "ses_1", role: "assistant", time: { created: 2, completed: 3 }, parentID: "msg_u1" },
        ] as State["message"]["ses_1"],
      },
    })

    const result = applyDirectoryEvent(draft, {
      type: "ompchamber:command-output",
      properties: { sessionID: "ses_1", text: "session: abc123", command: "session" },
    } as Event)

    expect(result).toBe(true)
    const messages = draft.message.ses_1
    expect(messages.length).toBe(3)
    // Locate by the dedupe key: fixture ids above do not follow the ascending
    // id format, so array position is not meaningful here.
    const appended = messages.find((message) => (message as { commandOutputKey?: unknown }).commandOutputKey !== undefined)
    expect(appended).toBeDefined()
    expect(appended?.role).toBe("assistant")
    expect((appended as { parentID?: unknown }).parentID).toBe("msg_u1")
    expect((appended as { finish?: unknown }).finish).toBe("stop")
    expect(typeof (appended?.time as { completed?: unknown }).completed).toBe("number")
    const parts = draft.part[(appended as NonNullable<typeof appended>).id]
    expect(parts.length).toBe(1)
    expect(parts[0].type).toBe("text")
    expect((parts[0] as { text?: unknown }).text).toBe("session: abc123")
    expect((parts[0] as { synthetic?: unknown }).synthetic).toBe(true)
    expect((parts[0] as { metadata?: unknown }).metadata).toEqual({ command: "session" })
  })

  test("deduplicates replayed ompchamber:command-output deliveries", () => {
    const draft = state({
      message: {
        ses_1: [{ id: "msg_u1", sessionID: "ses_1", role: "user", time: { created: 1 } }] as State["message"]["ses_1"],
      },
    })
    const event = {
      id: "evt_42",
      type: "ompchamber:command-output",
      properties: { sessionID: "ses_1", text: "session: abc123", command: "session" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.message.ses_1.length).toBe(2)

    // Identical payload without an event id also collapses.
    const anonymous = {
      type: "ompchamber:command-output",
      properties: { sessionID: "ses_1", text: "session: abc123", command: "session" },
    } as Event
    expect(applyDirectoryEvent(draft, anonymous)).toBe(false)
    expect(draft.message.ses_1.length).toBe(2)

    // A different output is a new message.
    expect(applyDirectoryEvent(draft, {
      type: "ompchamber:command-output",
      properties: { sessionID: "ses_1", text: "session: def456", command: "session" },
    } as Event)).toBe(true)
    expect(draft.message.ses_1.length).toBe(3)
  })

  test("parents ompchamber:command-output to an explicit payload messageID", () => {
    const draft = state({
      message: {
        ses_1: [
          { id: "msg_u1", sessionID: "ses_1", role: "user", time: { created: 1 } },
          { id: "msg_u2", sessionID: "ses_1", role: "user", time: { created: 2 } },
          { id: "msg_a2", sessionID: "ses_1", role: "assistant", time: { created: 3 }, parentID: "msg_u2" },
        ] as State["message"]["ses_1"],
      },
    })

    applyDirectoryEvent(draft, {
      type: "ompchamber:command-output",
      properties: { sessionID: "ses_1", text: "out", messageID: "msg_u1" },
    } as Event)
    const findAppended = (text: string) => draft.message.ses_1.find((message) => (
      (message as { commandOutputKey?: unknown }).commandOutputKey === JSON.stringify(["ses_1", text === "out" ? "msg_u1" : "msg_a2", "", text])
    ))
    expect((findAppended("out") as { parentID?: unknown }).parentID).toBe("msg_u1")

    applyDirectoryEvent(draft, {
      type: "ompchamber:command-output",
      properties: { sessionID: "ses_1", text: "out2", messageID: "msg_a2" },
    } as Event)
    expect((findAppended("out2") as { parentID?: unknown }).parentID).toBe("msg_u2")
  })

  test("creates a hidden user marker when no user message is loaded", () => {
    const draft = state()

    const result = applyDirectoryEvent(draft, {
      type: "ompchamber:command-output",
      properties: { sessionID: "ses_1", text: "out", command: "session" },
    } as Event)

    expect(result).toBe(true)
    const messages = draft.message.ses_1
    expect(messages.length).toBe(2)
    const [marker, appended] = messages
    expect(marker.role).toBe("user")
    expect((marker as { commandOutputMarker?: unknown }).commandOutputMarker).toBe(true)
    expect((appended as { parentID?: unknown }).parentID).toBe(marker.id)
    const markerParts = draft.part[marker.id]
    expect(markerParts.length).toBe(1)
    expect((markerParts[0] as { synthetic?: unknown }).synthetic).toBe(true)
    expect((markerParts[0] as { text?: unknown }).text).toBe("/session")
  })

  test("ignores ompchamber:command-output without session or text", () => {
    const draft = state()

    expect(applyDirectoryEvent(draft, {
      type: "ompchamber:command-output",
      properties: { text: "out" },
    } as Event)).toBe(false)
    expect(applyDirectoryEvent(draft, {
      type: "ompchamber:command-output",
      properties: { sessionID: "ses_1" },
    } as Event)).toBe(false)
    expect(draft.message.ses_1).toBe(undefined)
  })
})
