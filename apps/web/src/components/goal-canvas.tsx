"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dagre from "@dagrejs/dagre";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  useReactFlow
} from "@xyflow/react";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Clock3,
  Focus,
  Maximize2,
  Minimize2,
  PauseCircle,
  Search
} from "lucide-react";
import type { GoalCanvasSnapshot } from "@council/contracts";
import { buildAgentWorkspaceHref, buildMeetingWorkspaceHref, buildTaskWorkspaceHref } from "../lib/workspace-navigation";

type GoalCanvasNodeProjection = GoalCanvasSnapshot["nodes"][number];
type GoalCanvasNodeType = GoalCanvasNodeProjection["type"];
type GoalCanvasStatus = GoalCanvasNodeProjection["status"];

interface GoalCanvasNodeData extends GoalCanvasNodeProjection {
  [key: string]: unknown;
  onActivate(node: GoalCanvasNodeProjection): void;
}

type GoalFlowNode = Node<GoalCanvasNodeData, "goal">;

export interface GoalCanvasNodeAction {
  href: string;
  label: string;
}

export interface GoalCanvasContext {
  goalId: string;
  meetingId: string;
  threadId: string;
}

const nodeWidth = 218;
const nodeHeight = 108;
const statusLabels: Record<GoalCanvasStatus, string> = {
  waiting: "等待",
  running: "執行中",
  completed: "完成",
  paused: "暫停",
  failed: "失敗",
  blocked: "阻塞"
};
const statusIcons = {
  waiting: Clock3,
  running: Circle,
  completed: CheckCircle2,
  paused: PauseCircle,
  failed: AlertCircle,
  blocked: AlertCircle
};
const nodeTypeLabels: Record<GoalCanvasNodeType, string> = {
  phase: "階段",
  task: "任務",
  runtime: "Runtime",
  agent: "Agent",
  role: "角色",
  model: "模型",
  tool: "工具",
  data: "資料",
  action: "Action",
  review: "審查"
};

function detailText(detail: GoalCanvasNodeProjection["detail"]): string {
  return Object.entries(detail)
    .filter(([, value]) => value !== null && value !== "")
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
}

export function goalCanvasNodeActions(node: GoalCanvasNodeProjection, context: GoalCanvasContext): GoalCanvasNodeAction[] {
  const source = { goalId: context.goalId, meetingId: context.meetingId, threadId: context.threadId };
  const meetingAction = {
    href: buildMeetingWorkspaceHref({
      meetingId: context.meetingId,
      threadId: context.threadId,
      fromGoalId: context.goalId,
      view: "meeting"
    }),
    label: "開啟會議"
  };
  if (node.type === "task" && node.entityId) {
    return [meetingAction, { href: buildTaskWorkspaceHref({ taskId: node.entityId, source }), label: "開啟任務" }];
  }
  if (node.type === "runtime" && typeof node.detail.taskId === "string") {
    return [meetingAction, { href: buildTaskWorkspaceHref({ taskId: node.detail.taskId, source }), label: "開啟任務" }];
  }
  if ((node.type === "agent" || node.type === "data") && node.entityId) {
    return [meetingAction, { href: buildAgentWorkspaceHref({ agentId: node.entityId, source }), label: "查看 Agent" }];
  }
  return [meetingAction];
}

function GoalCanvasNode({ data }: NodeProps<GoalFlowNode>) {
  const Icon = statusIcons[data.status];
  const detail = detailText(data.detail);
  return <button
    type="button"
    className={`goal-flow-node ${data.status}`}
    onClick={() => data.onActivate(data)}
    aria-label={`${data.label}，${nodeTypeLabels[data.type]}，${statusLabels[data.status]}`}
  >
    <Handle type="target" position={Position.Left} aria-hidden="true" />
    <span className="goal-flow-node-status"><Icon size={14} aria-hidden="true" />{statusLabels[data.status]}</span>
    <strong>{data.label}</strong>
    <small>{nodeTypeLabels[data.type]}{detail ? ` · ${detail}` : ""}</small>
    <Handle type="source" position={Position.Right} aria-hidden="true" />
  </button>;
}

const nodeTypes = { goal: GoalCanvasNode } satisfies NodeTypes;

function layout(
  snapshot: Pick<GoalCanvasSnapshot, "nodes" | "edges">,
  onActivate: (node: GoalCanvasNodeProjection) => void
): { nodes: GoalFlowNode[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 76, marginx: 28, marginy: 28 });
  snapshot.nodes.forEach((node) => graph.setNode(node.id, { width: nodeWidth, height: nodeHeight }));
  snapshot.edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
  dagre.layout(graph);
  return {
    nodes: snapshot.nodes.map((node) => {
      const point = graph.node(node.id);
      return {
        id: node.id,
        type: "goal",
        position: { x: point.x - nodeWidth / 2, y: point.y - nodeHeight / 2 },
        data: { ...node, onActivate }
      };
    }),
    edges: snapshot.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label ?? undefined,
      type: "smoothstep",
      animated: edge.type === "sequence" && snapshot.nodes.some((node) => node.id === edge.target && node.status === "running")
    }))
  };
}

function GoalCanvasViewport({
  snapshot,
  search,
  typeFilter,
  focusRequest,
  onActivate
}: {
  snapshot: GoalCanvasSnapshot;
  search: string;
  typeFilter: GoalCanvasNodeType | "all";
  focusRequest: number;
  onActivate(node: GoalCanvasNodeProjection): void;
}) {
  const { fitView, setCenter } = useReactFlow();
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const visibleIds = new Set(snapshot.nodes.filter((node) => (
      (typeFilter === "all" || node.type === typeFilter)
      && (!query || `${node.label} ${node.type} ${node.status} ${detailText(node.detail)}`.toLocaleLowerCase().includes(query))
    )).map((node) => node.id));
    return {
      nodes: snapshot.nodes.filter((node) => visibleIds.has(node.id)),
      edges: snapshot.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    };
  }, [search, snapshot, typeFilter]);
  const flow = useMemo(() => layout(filtered, onActivate), [filtered, onActivate]);

  useEffect(() => { void fitView({ padding: 0.2, duration: 180 }); }, [fitView, flow.nodes.length, snapshot.lens]);
  useEffect(() => {
    if (focusRequest === 0) return;
    const current = flow.nodes.find((node) => node.data.status === "running")
      ?? flow.nodes.find((node) => node.data.status === "blocked" || node.data.status === "paused")
      ?? flow.nodes[0];
    if (current) void setCenter(current.position.x + nodeWidth / 2, current.position.y + nodeHeight / 2, { zoom: 1, duration: 220 });
  }, [flow.nodes, focusRequest, setCenter]);

  return <>
    <ReactFlow<GoalFlowNode>
      nodes={flow.nodes}
      edges={flow.edges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.25}
      maxZoom={1.75}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={18} size={1} />
      <MiniMap pannable zoomable ariaLabel="Goal 畫布縮圖" />
      <Controls showInteractive={false} />
    </ReactFlow>
    {flow.nodes.length === 0 && <p className="goal-canvas-empty">沒有符合搜尋或篩選條件的節點。</p>}
  </>;
}

export function GoalCanvas({ snapshot, context }: { snapshot: GoalCanvasSnapshot; context: GoalCanvasContext }) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<GoalCanvasNodeType | "all">("all");
  const [focusRequest, setFocusRequest] = useState(0);
  const [fullScreen, setFullScreen] = useState(false);
  const [selected, setSelected] = useState<GoalCanvasNodeProjection | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const fullScreenTriggerRef = useRef<HTMLButtonElement>(null);
  const wasFullScreenRef = useRef(false);
  const activate = useCallback((node: GoalCanvasNodeProjection) => {
    setSelected(node);
  }, []);

  useEffect(() => {
    if (!fullScreen) return;
    shellRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullScreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullScreen]);

  useEffect(() => {
    if (!fullScreen && wasFullScreenRef.current) fullScreenTriggerRef.current?.focus();
    wasFullScreenRef.current = fullScreen;
  }, [fullScreen]);

  return <div ref={shellRef} tabIndex={fullScreen ? -1 : undefined} className={`goal-flow-shell ${fullScreen ? "fullscreen" : ""}`} role={fullScreen ? "dialog" : undefined} aria-modal={fullScreen || undefined} aria-label={fullScreen ? "Goal 全螢幕畫布" : undefined}>
    <div className="goal-flow-toolbar">
      <label className="canvas-search"><Search size={15} aria-hidden="true" /><span className="sr-only">搜尋 Goal 畫布</span><input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="搜尋節點" /></label>
      <label className="canvas-kind-filter"><span className="sr-only">篩選 Goal 畫布節點類型</span><select value={typeFilter} onChange={(event) => setTypeFilter(event.currentTarget.value as GoalCanvasNodeType | "all")}><option value="all">全部節點</option>{Object.entries(nodeTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="icon-button" type="button" onClick={() => setFocusRequest((current) => current + 1)} title="聚焦目前節點" aria-label="聚焦目前節點"><Focus size={16} /></button>
      <button ref={fullScreenTriggerRef} className="icon-button" type="button" onClick={() => setFullScreen((current) => !current)} title={fullScreen ? "離開全螢幕" : "全螢幕畫布"} aria-label={fullScreen ? "離開全螢幕" : "全螢幕畫布"} aria-pressed={fullScreen}>{fullScreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
    </div>
    <div className="goal-flow-viewport" aria-label={`${snapshot.lens} Goal 狀態畫布，${snapshot.nodes.length} 個節點`}>
      <ReactFlowProvider>
        <GoalCanvasViewport snapshot={snapshot} search={search} typeFilter={typeFilter} focusRequest={focusRequest} onActivate={activate} />
      </ReactFlowProvider>
    </div>
    {selected && <div className="goal-flow-selection" aria-live="polite"><div><strong>{selected.label}</strong><span>{nodeTypeLabels[selected.type]} · {statusLabels[selected.status]}</span></div><small>{detailText(selected.detail) || "此節點沒有其他投影資料。"}</small><nav className="goal-flow-selection-actions" aria-label={`${selected.label} 的可用動作`}>{goalCanvasNodeActions(selected, context).map((action) => <Link key={action.href} className="secondary-button small" href={action.href}>{action.label}</Link>)}</nav></div>}
  </div>;
}
