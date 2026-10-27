import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import {
  CommittedMutationProjectionError,
  loadProjectionWithRecovery,
  mutateWithProjectionRefresh,
  ProjectionRefreshSupersededError,
  projectionFailureMessage,
  rejectSupersededProjectionRefresh,
  resolveCommittedMutation
} from "./providers";

const source = readFileSync(new URL("./providers.tsx", import.meta.url), "utf8");

describe("Platform Provider route ownership", () => {
  it("refreshes the current route after a mutation settles", () => {
    expect(source).toContain("refreshRef.current = refresh");
    expect(source).toContain("return mutateWithProjectionRefresh(");
    expect(source).toContain("const commitMutation = useCallback");
    expect(source).toContain('const refreshRequired = useCallback(() => refresh("required"), [refresh]);');
    expect(source).toContain("() => refreshRef.current(\"required\")");
    expect(source).toContain("mode: ProjectionRefreshMode = \"passive\"");
    expect(source).toContain("if (mode === \"required\") throw cause;");
    expect(source).toContain("await loadProjectionWithRecovery(");
    expect(source).toContain("projectionFailureMessage(cause, hasRetainedProjection");
    expect(source).not.toContain("await refresh();\n    return result;");
  });

  it("does not suppress a required refresh failure when a newer refresh supersedes it", () => {
    expect(source).toContain(`if (sequence !== refreshSequenceRef.current) {
        if (mode === "required") throw cause;
        return;
      }`);
    expect(source).toContain(`if (meetingSequence !== null && meetingSequence !== meetingRefreshSequenceRef.current) {
        if (mode === "required") throw cause;
        return;
      }`);
  });

  it("keeps a retained Discussions projection usable when a passive Meeting refresh fails", () => {
    const meetingRefreshSource = source.slice(
      source.indexOf("  const refreshMeeting = useCallback"),
      source.indexOf("  const focusMeeting = useCallback")
    );

    expect(source).toContain("const requestedEndpoint = platformViewEndpoint(requestedPathname);");
    expect(meetingRefreshSource).toContain("const hasRetainedProjection = requestedEndpoint !== null && loadedEndpointRef.current === requestedEndpoint;");
    expect(meetingRefreshSource).toContain("if (hasRetainedProjection) setPlatformProjectionStale(true);");
    expect(meetingRefreshSource).toContain("setPlatformProjectionLastFailureAt(new Date().toISOString());");
    expect(meetingRefreshSource).toContain(`setError(projectionFailureMessage(
        cause,
        hasRetainedProjection,
        "無法讀取會議資料。"
      ));`);
    expect(source).not.toContain('setError(cause instanceof Error ? cause.message : "無法讀取會議資料。");');
  });

  it("does not load the full Meeting projection for an archived session", () => {
    expect(source).toContain("const focusedMeetingDetailsRef = useRef(true);");
    expect(source).toContain("focusedMeetingDetailsRef.current ? focusedMeetingIdRef.current : null");
    expect(source).toContain("const focusMeeting = useCallback((meetingId: string | null, includeDetails = true) => {");
    expect(source).toContain("focusedMeetingDetailsRef.current = includeDetails;");
    expect(source).toContain("if (meetingId && includeDetails) void refreshMeeting(meetingId);");
  });

  it("marks a retained platform projection stale until a later refresh succeeds", () => {
    expect(source).toContain("platformProjectionStale: boolean;");
    expect(source).toContain("platformProjectionRefreshing: boolean;");
    expect(source).toContain("platformProjectionLastSuccessfulAt: string | null;");
    expect(source).toContain("platformProjectionLastFailureAt: string | null;");
    expect(source).toContain("const [platformProjectionStale, setPlatformProjectionStale] = useState(false);");
    expect(source).toContain("if (!hasRetainedProjection) {");
    expect(source).toContain("setPlatformProjectionStale(false);");
    expect(source).toContain("if (hasRetainedProjection) setPlatformProjectionStale(true);");
    expect(source).toContain("setPlatformProjectionLastSuccessfulAt(new Date().toISOString());");
    expect(source).toContain("setPlatformProjectionLastFailureAt(new Date().toISOString());");
    expect(source).toContain("platformProjectionLastSuccessfulAt,");
  });

  it("rejects a required refresh whose successful response was superseded before projection apply", () => {
    expect(() => rejectSupersededProjectionRefresh("required"))
      .toThrow(ProjectionRefreshSupersededError);
    expect(() => rejectSupersededProjectionRefresh("passive")).not.toThrow();
    expect(source).toContain(`if (sequence !== refreshSequenceRef.current) {
        rejectSupersededProjectionRefresh(mode);
        return;
      }`);
    expect(source).toContain(`if (focusedMeetingId !== currentFocusedMeetingId) {
        rejectSupersededProjectionRefresh(mode);`);
  });

  it("rejects a committed mutation when the required projection refresh exhausts recovery", async () => {
    const retainedSnapshot = { revision: 1, label: "retained" };
    let visibleSnapshot: typeof retainedSnapshot | null = null;
    let hasRetainedProjection = false;
    const failure = new ApiError(503, "Projection temporarily unavailable.");
    const projectionGet = vi.fn<() => Promise<typeof retainedSnapshot>>()
      .mockResolvedValueOnce(retainedSnapshot)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure);
    const refreshProjection = async () => {
      const next = await loadProjectionWithRecovery(projectionGet, hasRetainedProjection);
      visibleSnapshot = next;
      hasRetainedProjection = true;
    };

    await refreshProjection();
    expect(visibleSnapshot).toBe(retainedSnapshot);

    const result = { id: "agent-1", revision: 2 };
    const commitMutation = vi.fn(async () => result);
    const cause = await mutateWithProjectionRefresh(commitMutation, refreshProjection)
      .catch((error: unknown) => error);

    expect(cause).toBeInstanceOf(CommittedMutationProjectionError);
    if (!(cause instanceof CommittedMutationProjectionError)) throw cause;
    expect(cause).toMatchObject({
      committed: true,
      result,
      message: "操作已完成，但最新資料刷新失敗，目前畫面仍顯示先前狀態。請重新整理後確認。"
    });
    expect(cause.result).toBe(result);
    expect(cause.cause).toBe(failure);
    expect(visibleSnapshot).toBe(retainedSnapshot);
    expect(commitMutation).toHaveBeenCalledTimes(1);
    expect(projectionGet).toHaveBeenCalledTimes(3);
  });

  it("recovers only a typed committed result while preserving projection freshness", async () => {
    const result = { id: "meeting-1" };
    const projectionFailure = new CommittedMutationProjectionError(result, new Error("projection unavailable"));
    const ordinaryFailure = new Error("commit failed");

    await expect(resolveCommittedMutation(async () => result)).resolves.toEqual({
      result,
      projectionFresh: true
    });
    await expect(resolveCommittedMutation(async () => { throw projectionFailure; })).resolves.toEqual({
      result,
      projectionFresh: false
    });
    await expect(resolveCommittedMutation(async () => { throw ordinaryFailure; })).rejects.toBe(ordinaryFailure);
  });

  it("recovers a committed mutation after one projection 503 without discarding retained content", async () => {
    const retainedSnapshot = { revision: 1, label: "retained" };
    const restoredSnapshot = { revision: 2, label: "committed" };
    let visibleSnapshot = retainedSnapshot;
    let pageError: string | null = null;
    let resolveRestoredGet!: (snapshot: typeof restoredSnapshot) => void;
    const restoredGet = new Promise<typeof restoredSnapshot>((resolve) => {
      resolveRestoredGet = resolve;
    });
    const projectionGet = vi.fn<() => Promise<typeof retainedSnapshot | typeof restoredSnapshot>>()
      .mockRejectedValueOnce(new ApiError(503, "Projection temporarily unavailable."))
      .mockImplementationOnce(() => restoredGet);
    const commitMutation = vi.fn(async () => ({ committed: true }));

    const mutationResult = await commitMutation();
    const refresh = loadProjectionWithRecovery(projectionGet, true)
      .then((next) => {
        visibleSnapshot = next;
        pageError = null;
      })
      .catch((cause: unknown) => {
        pageError = projectionFailureMessage(cause, true, "Unable to load platform data.");
      });

    await vi.waitFor(() => expect(projectionGet).toHaveBeenCalledTimes(2));
    expect(mutationResult).toEqual({ committed: true });
    expect(visibleSnapshot).toBe(retainedSnapshot);
    expect(pageError).toBeNull();

    resolveRestoredGet(restoredSnapshot);
    await refresh;

    expect(visibleSnapshot).toBe(restoredSnapshot);
    expect(pageError).toBeNull();
  });

  it("bounds automatic recovery to one retry and keeps retained content usable", async () => {
    const failure = new ApiError(503, "Projection temporarily unavailable.");
    const projectionGet = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    const cause = await loadProjectionWithRecovery(projectionGet, true).catch((error: unknown) => error);

    expect(cause).toBe(failure);
    expect(projectionGet).toHaveBeenCalledTimes(2);
    expect(projectionFailureMessage(cause, true, "Unable to load platform data.")).toBeNull();
  });

  it("keeps first-load failures explicit without retrying", async () => {
    const failure = new ApiError(503, "Projection temporarily unavailable.");
    const projectionGet = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    const cause = await loadProjectionWithRecovery(projectionGet, false).catch((error: unknown) => error);

    expect(cause).toBe(failure);
    expect(projectionGet).toHaveBeenCalledTimes(1);
    expect(projectionFailureMessage(cause, false, "Unable to load platform data."))
      .toBe("Projection temporarily unavailable.");
  });
});
