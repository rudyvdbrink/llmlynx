// Tests of the URL helper.

import { describe, expect, it } from "vitest";
import { hostOf } from "./urls";

describe("hostOf", () => {
  it("gives the host, or null", () => {
    expect(hostOf("https://Docs.Example.com:8443/a?b")).toBe("docs.example.com");
    expect(hostOf("nonsense")).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
});
