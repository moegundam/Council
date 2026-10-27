"use client";

import dynamic from "next/dynamic";
import { LoaderCircle } from "lucide-react";

function MeetingCanvasLoadingState() {
  return <section className="meeting-canvas" aria-labelledby="meeting-canvas-loading-title">
    <div className="canvas-viewport canvas-viewport-loading" role="status" aria-label="正在載入會議畫布" aria-live="polite">
      <LoaderCircle className="spin-icon" size={18} aria-hidden="true" />
      <span id="meeting-canvas-loading-title">正在載入會議畫布</span>
    </div>
  </section>;
}

export const MeetingCanvasLoader = dynamic(
  () => import("./meeting-canvas").then(({ MeetingCanvas }) => MeetingCanvas),
  { ssr: false, loading: MeetingCanvasLoadingState }
);
