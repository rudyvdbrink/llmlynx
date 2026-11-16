// Tests of the pauses: who can answer one, how often, and what ends it without an answer.

import { describe, expect, it } from "vitest";
import { answerPause, openPause } from "./pause";

const never = () => new AbortController().signal;

describe("a pause", () => {
  it("resolves with the user's choice", async () => {
    const remove = openPause("user-1", never());
    const stop = openPause("user-1", never());
    expect(answerPause(remove.id, "user-1", "remove")).toBe(true);
    expect(answerPause(stop.id, "user-1", "stop")).toBe(true);
    expect(await remove.decision).toBe("remove");
    expect(await stop.decision).toBe("stop");
  });

  it("works once", async () => {
    const pause = openPause("user-1", never());
    expect(answerPause(pause.id, "user-1", "remove")).toBe(true);
    expect(answerPause(pause.id, "user-1", "stop")).toBe(false);
    expect(await pause.decision).toBe("remove");
  });

  it("cannot be answered by another user, and stays open for its own", async () => {
    const pause = openPause("user-1", never());
    expect(answerPause(pause.id, "user-2", "remove")).toBe(false);
    expect(answerPause(pause.id, "user-1", "remove")).toBe(true);
    expect(await pause.decision).toBe("remove");
  });

  it("has an id that cannot be guessed from another one", () => {
    const first = openPause("user-1", never());
    const second = openPause("user-1", never());
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(answerPause("no-such-pause", "user-1", "remove")).toBe(false);
    answerPause(first.id, "user-1", "stop");
    answerPause(second.id, "user-1", "stop");
  });

  it("ends as stop when nobody answers in time", async () => {
    const pause = openPause("user-1", never(), 20);
    expect(await pause.decision).toBe("stop");
    expect(answerPause(pause.id, "user-1", "remove")).toBe(false);
  });

  it("ends as stop when the chat is stopped or the client is gone", async () => {
    const chat = new AbortController();
    const pause = openPause("user-1", chat.signal);
    chat.abort();
    expect(await pause.decision).toBe("stop");
    expect(answerPause(pause.id, "user-1", "remove")).toBe(false);
  });

  it("ends as stop at once for a chat that was already stopped", async () => {
    const chat = new AbortController();
    chat.abort();
    expect(await openPause("user-1", chat.signal).decision).toBe("stop");
  });
});
