"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps, type NodeTypes, useReactFlow } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { AlertCircle, CheckCircle2, Circle, Clock3, Link2, PauseCircle, Search } from "lucide-react";
import type { CanvasLens, CanvasNodeProjection, CanvasProjection } from "../lib/meeting-experience";

const nodeWidth = 210;
const nodeHeight = 106;
const statusIcons = { alert: AlertCircle, check: CheckCircle2, circle: Circle, clock: Clock3, link: Link2, pause: PauseCircle };

interface CanvasNodeData extends CanvasNodeProjection {
  [key: string]: unknown;
  onReturnToMeeting: (node: CanvasNodeProjection) => void;
}

type MeetingCanvasFlowNode = Node<CanvasNodeData, "meeting">;

function MeetingCanvasNode({ data }: NodeProps<MeetingCanvasFlowNode>) {
  const Icon = statusIcons[data.status.icon];
  return <button type="button" className={`canvas-node ${data.status.tone}`} onClick={() => data.onReturnToMeeting(data)} aria-label={`${data.label}，${data.status.label}。返回會議檢視`}>
    <Handle type="target" position={Position.Left} aria-hidden="true" />
    <span className="canvas-node-status"><Icon size={14} aria-hidden="true" />{data.status.label}</span>
    <strong>{data.label}</strong><small>{data.detail}</small>
    <Handle type="source" position={Position.Right} aria-hidden="true" />
  </button>;
}

const nodeTypes = { meeting: MeetingCanvasNode } satisfies NodeTypes;

function layout(projection: CanvasProjection, onReturnToMeeting: (node: CanvasNodeProjection) => void): { nodes: MeetingCanvasFlowNode[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", nodesep: 32, ranksep: 72, marginx: 24, marginy: 24 });
  for (const item of projection.nodes) graph.setNode(item.id, { width: nodeWidth, height: nodeHeight });
  for (const edge of projection.edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  return {
    nodes: projection.nodes.map((item) => {
      const position = graph.node(item.id);
      return { id: item.id, type: "meeting", position: { x: position.x - nodeWidth / 2, y: position.y - nodeHeight / 2 }, data: { ...item, onReturnToMeeting } };
    }),
    edges: projection.edges.map((item) => ({ id: item.id, source: item.source, target: item.target, label: item.label, type: "smoothstep", animated: false }))
  };
}

function FitCanvas({ search }: { search: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => { void fitView({ padding: 0.18, duration: 180 }); }, [fitView, search]);
  return null;
}

export function MeetingCanvas({ lens, projection, onReturnToMeeting }: { lens: CanvasLens; projection: CanvasProjection; onReturnToMeeting: () => void }) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<CanvasNodeProjection["kind"] | "all">("all");
  const visibleProjection = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const visibleIds = new Set(projection.nodes.filter((node) => (kindFilter === "all" || node.kind === kindFilter)
      && (!query || `${node.label} ${node.detail} ${node.status.label}`.toLocaleLowerCase().includes(query))).map((node) => node.id));
    const edges = projection.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    return { nodes: projection.nodes.filter((node) => visibleIds.has(node.id)), edges };
  }, [kindFilter, projection, search]);
  const selectNode = useCallback((_node: CanvasNodeProjection) => onReturnToMeeting(), [onReturnToMeeting]);
  const flow = useMemo(() => layout(visibleProjection, selectNode), [selectNode, visibleProjection]);
  const lensLabels: Record<CanvasLens, string> = { progress: "進度", collaboration: "協作", resources: "資源" };

  return <section className="meeting-canvas" aria-labelledby="meeting-canvas-title">
    <header className="meeting-canvas-header"><div><span className="eyebrow">Canvas</span><h2 id="meeting-canvas-title">{lensLabels[lens]}關聯圖</h2></div><div className="canvas-filters"><label className="canvas-search"><Search size={15} aria-hidden="true" /><span className="sr-only">搜尋畫布節點</span><input aria-label="搜尋畫布節點" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="搜尋節點" /></label><label className="canvas-kind-filter"><span className="sr-only">篩選節點類型</span><select value={kindFilter} onChange={(event) => setKindFilter(event.currentTarget.value as CanvasNodeProjection["kind"] | "all")}><option value="all">全部節點</option><option value="agenda">議程</option><option value="participant">參與者</option><option value="message">發言</option><option value="decision">決議</option><option value="task">任務</option><option value="evidence">證據</option></select></label></div></header>
    <p className="canvas-instruction" role="status">點選節點可返回會議檢視。此畫布僅供檢視。</p>
    <div className="canvas-viewport" aria-label={`${lensLabels[lens]}關聯圖，${visibleProjection.nodes.length} 個節點`}>
      <ReactFlow<MeetingCanvasFlowNode> nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} fitView minZoom={0.3} maxZoom={1.6} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
        <FitCanvas search={search} />
        <Background gap={18} size={1} />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
    <section className="canvas-summary" aria-label="畫布語意摘要"><h3>關聯摘要</h3><ul>{visibleProjection.nodes.map((node) => <li key={node.id}><strong>{node.label}</strong><span>{node.status.label}</span><small>{node.detail}</small></li>)}</ul></section>
  </section>;
}
