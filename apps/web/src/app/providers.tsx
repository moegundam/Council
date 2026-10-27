"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type {
  PublicMeetingViewSnapshot as MeetingViewSnapshot,
  PublicPlatformSnapshot as PlatformSnapshot
} from "@council/contracts";
import { ApiError, apiRequest } from "../lib/api";
import { meetingViewFromSnapshot, mergeMeetingView, platformViewEndpoint } from "../lib/platform-projection";

interface PlatformContextValue {
  platformProjectionStale: boolean;
  platformProjectionRefreshing: boolean;
  platformProjectionLastSuccessfulAt: string | null;
  platformProjectionLastFailureAt: string | null;
  snapshot: PlatformSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  refreshRequired(): Promise<void>;
  refreshMeeting(meetingId: string): Promise<void>;
  focusMeeting(meetingId: string | null, includeDetails?: boolean): void;
  mutate<T>(path: string, init: RequestInit): Promise<T>;
  commitMutation<T>(commit: () => Promise<T>): Promise<T>;
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

export class CommittedMutationProjectionError<T = unknown> extends Error {
  readonly committed = true as const;
  readonly result: T;

  constructor(result: T, cause: unknown) {
    super("操作已完成，但最新資料刷新失敗，目前畫面仍顯示先前狀態。請重新整理後確認。", { cause });
    this.name = "CommittedMutationProjectionError";
    this.result = result;
  }
}

export interface CommittedMutationOutcome<T> {
  result: T;
  projectionFresh: boolean;
}

export async function resolveCommittedMutation<T>(
  mutation: () => Promise<T>
): Promise<CommittedMutationOutcome<T>> {
  try {
    return {
      result: await mutation(),
      projectionFresh: true
    };
  } catch (cause) {
    if (!(cause instanceof CommittedMutationProjectionError)) throw cause;
    return {
      result: cause.result as T,
      projectionFresh: false
    };
  }
}

export async function mutateWithProjectionRefresh<T>(
  commit: () => Promise<T>,
  refresh: () => Promise<void>
): Promise<T> {
  const result = await commit();
  try {
    await refresh();
  } catch (cause) {
    throw new CommittedMutationProjectionError(result, cause);
  }
  return result;
}

export async function loadProjectionWithRecovery<T>(
  load: () => Promise<T>,
  hasRetainedProjection: boolean,
  canRecover: () => boolean = () => true
): Promise<T> {
  try {
    return await load();
  } catch (cause) {
    if (!hasRetainedProjection
      || !canRecover()
      || !(cause instanceof ApiError)
      || cause.status !== 503) throw cause;
    return load();
  }
}

export function projectionFailureMessage(
  cause: unknown,
  hasRetainedProjection: boolean,
  fallback: string
): string | null {
  if (hasRetainedProjection) return null;
  return cause instanceof Error ? cause.message : fallback;
}

export type ProjectionRefreshMode = "passive" | "required";

export class ProjectionRefreshSupersededError extends Error {
  constructor() {
    super("Required projection refresh was superseded before it could be applied.");
    this.name = "ProjectionRefreshSupersededError";
  }
}

export function rejectSupersededProjectionRefresh(mode: ProjectionRefreshMode): void {
  if (mode === "required") throw new ProjectionRefreshSupersededError();
}

export function PlatformProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<PlatformSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [platformProjectionStale, setPlatformProjectionStale] = useState(false);
  const [platformProjectionRefreshing, setPlatformProjectionRefreshing] = useState(false);
  const [platformProjectionLastSuccessfulAt, setPlatformProjectionLastSuccessfulAt] = useState<string | null>(null);
  const [platformProjectionLastFailureAt, setPlatformProjectionLastFailureAt] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const refreshSequenceRef = useRef(0);
  const meetingRefreshSequenceRef = useRef(0);
  const loadedEndpointRef = useRef<string | null>(null);
  const focusedMeetingIdRef = useRef<string | null>(null);
  const focusedMeetingDetailsRef = useRef(true);
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const refresh = useCallback(async (mode: ProjectionRefreshMode = "passive") => {
    const sequence = ++refreshSequenceRef.current;
    if (pathname.startsWith("/docs")) {
      setError(null);
      setPlatformProjectionStale(false);
      setPlatformProjectionRefreshing(false);
      setPlatformProjectionLastSuccessfulAt(null);
      setPlatformProjectionLastFailureAt(null);
      setLoading(false);
      return;
    }
    const endpoint = platformViewEndpoint(pathname);
    if (!endpoint) {
      setError(null);
      setPlatformProjectionStale(false);
      setPlatformProjectionRefreshing(false);
      setPlatformProjectionLastSuccessfulAt(null);
      setPlatformProjectionLastFailureAt(null);
      setLoading(false);
      return;
    }
    const focusedMeetingId = endpoint === "/api/v1/views/discussions"
      ? focusedMeetingDetailsRef.current ? focusedMeetingIdRef.current : null
      : null;
    const meetingSequence = focusedMeetingId ? ++meetingRefreshSequenceRef.current : null;
    const hasRetainedProjection = loadedEndpointRef.current === endpoint;
    setPlatformProjectionRefreshing(true);
    if (!hasRetainedProjection) {
      setPlatformProjectionStale(false);
      setPlatformProjectionLastSuccessfulAt(null);
      setPlatformProjectionLastFailureAt(null);
      setLoading(true);
    }
    try {
      const loadProjection = () => Promise.all([
        apiRequest<PlatformSnapshot>(endpoint),
        focusedMeetingId
          ? apiRequest<MeetingViewSnapshot>(`/api/v1/meetings/${focusedMeetingId}/view`)
          : Promise.resolve(null)
      ]);
      const [base, meetingView] = await loadProjectionWithRecovery(
        loadProjection,
        hasRetainedProjection,
        () => sequence === refreshSequenceRef.current
      );
      if (sequence !== refreshSequenceRef.current) {
        rejectSupersededProjectionRefresh(mode);
        return;
      }
      const currentFocusedMeetingId = endpoint === "/api/v1/views/discussions"
        ? focusedMeetingDetailsRef.current ? focusedMeetingIdRef.current : null
        : null;
      if (focusedMeetingId !== currentFocusedMeetingId) {
        rejectSupersededProjectionRefresh(mode);
        void refresh();
        return;
      }
      const meetingResponseIsLatest = meetingSequence === null || meetingSequence === meetingRefreshSequenceRef.current;
      setSnapshot((current) => {
        if (!meetingView) return base;
        if (meetingResponseIsLatest) return mergeMeetingView(base, meetingView);
        const currentMeetingView = current && focusedMeetingId
          ? meetingViewFromSnapshot(current, focusedMeetingId)
          : null;
        return currentMeetingView ? mergeMeetingView(base, currentMeetingView) : base;
      });
      loadedEndpointRef.current = endpoint;
      setError(null);
      setPlatformProjectionStale(false);
      setPlatformProjectionLastSuccessfulAt(new Date().toISOString());
      setPlatformProjectionLastFailureAt(null);
      if (pathname === "/login") router.replace("/");
    } catch (cause) {
      if (sequence !== refreshSequenceRef.current) {
        if (mode === "required") throw cause;
        return;
      }
      if (meetingSequence !== null && meetingSequence !== meetingRefreshSequenceRef.current) {
        if (mode === "required") throw cause;
        return;
      }
      if (cause instanceof ApiError && cause.status === 401) {
        if (pathname !== "/login") router.replace("/login");
        setPlatformProjectionLastFailureAt(new Date().toISOString());
        if (mode === "required") throw cause;
        return;
      }
      if (hasRetainedProjection) setPlatformProjectionStale(true);
      setPlatformProjectionLastFailureAt(new Date().toISOString());
      setError(projectionFailureMessage(cause, hasRetainedProjection, "無法讀取平台資料。"));
      if (mode === "required") throw cause;
    } finally {
      if (sequence === refreshSequenceRef.current) {
        setPlatformProjectionRefreshing(false);
        setLoading(false);
      }
    }
  }, [pathname, router]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const refreshRequired = useCallback(() => refresh("required"), [refresh]);

  const refreshMeeting = useCallback(async (meetingId: string) => {
    const sequence = ++meetingRefreshSequenceRef.current;
    const requestedPathname = pathnameRef.current;
    const requestedEndpoint = platformViewEndpoint(requestedPathname);
    const hasRetainedProjection = requestedEndpoint !== null && loadedEndpointRef.current === requestedEndpoint;
    try {
      const next = await apiRequest<MeetingViewSnapshot>(`/api/v1/meetings/${meetingId}/view`);
      if (sequence !== meetingRefreshSequenceRef.current
        || pathnameRef.current !== requestedPathname
        || focusedMeetingIdRef.current !== meetingId) return;
      setSnapshot((current) => current ? mergeMeetingView(current, next) : current);
      setError(null);
    } catch (cause) {
      if (sequence !== meetingRefreshSequenceRef.current
        || pathnameRef.current !== requestedPathname
        || focusedMeetingIdRef.current !== meetingId) return;
      if (hasRetainedProjection) setPlatformProjectionStale(true);
      setPlatformProjectionLastFailureAt(new Date().toISOString());
      setError(projectionFailureMessage(
        cause,
        hasRetainedProjection,
        "無法讀取會議資料。"
      ));
    }
  }, []);

  const focusMeeting = useCallback((meetingId: string | null, includeDetails = true) => {
    focusedMeetingIdRef.current = meetingId;
    focusedMeetingDetailsRef.current = includeDetails;
    if (meetingId && includeDetails) void refreshMeeting(meetingId);
    else meetingRefreshSequenceRef.current += 1;
  }, [refreshMeeting]);

  useEffect(() => { void refresh(); }, [refresh]);

  const mutate = useCallback(<T,>(path: string, init: RequestInit) => {
    return mutateWithProjectionRefresh(
      () => apiRequest<T>(path, init),
      () => refreshRef.current("required")
    );
  }, []);
  const commitMutation = useCallback(<T,>(commit: () => Promise<T>) => {
    return mutateWithProjectionRefresh(commit, () => refreshRef.current("required"));
  }, []);

  const value = useMemo(
    () => ({
      platformProjectionStale,
      platformProjectionRefreshing,
      platformProjectionLastSuccessfulAt,
      platformProjectionLastFailureAt,
      snapshot,
      loading,
      error,
      refresh,
      refreshRequired,
      refreshMeeting,
      focusMeeting,
      mutate,
      commitMutation
    }),
    [
      platformProjectionStale,
      platformProjectionRefreshing,
      platformProjectionLastSuccessfulAt,
      platformProjectionLastFailureAt,
      snapshot,
      loading,
      error,
      refresh,
      refreshRequired,
      refreshMeeting,
      focusMeeting,
      mutate,
      commitMutation
    ]
  );
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): PlatformContextValue {
  const value = useContext(PlatformContext);
  if (!value) throw new Error("PlatformProvider is missing.");
  return value;
}
