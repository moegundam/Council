import { notFound } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { GoalWorkspace } from "../../components/goal-workspace";
import { goalRunAutonomyUiEnabled } from "../../lib/feature-flags";

export default function GoalsPage() {
  if (!goalRunAutonomyUiEnabled) notFound();
  return <AppShell><GoalWorkspace /></AppShell>;
}
