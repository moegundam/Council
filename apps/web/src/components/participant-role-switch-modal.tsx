"use client";

import { useEffect, useState } from "react";
import type { ParticipantAssignment, Role } from "@council/contracts";
import { participantRoleSelectionIsNoop } from "../lib/role-ui";
import { Modal } from "./ui";

export function ParticipantRoleSwitchModal({
  open,
  participant,
  agentName,
  roles,
  busy,
  error,
  onClose,
  onSubmit
}: {
  open: boolean;
  participant: ParticipantAssignment | null;
  agentName: string;
  roles: readonly Role[];
  busy: boolean;
  error: string;
  onClose(): void;
  onSubmit(input: { roleId: string; reason: string }): void;
}) {
  const [roleId, setRoleId] = useState(participant?.roleId ?? "");
  useEffect(() => { if (open) setRoleId(participant?.roleId ?? ""); }, [open, participant?.id, participant?.roleId]);
  if (!participant) return null;
  const availableRoles = roles.filter((role) => role.deletedAt === null || role.id === participant.roleId);
  const selectedRole = availableRoles.find((role) => role.id === roleId);
  const noChange = participantRoleSelectionIsNoop(participant, selectedRole);
  const applyingNewVersion = selectedRole?.id === participant.roleId && !noChange;
  return <Modal title={`${agentName} 的角色`} open={open} onClose={onClose} closeDisabled={busy} busy={busy}>
    <form className="form-stack role-switch-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); onSubmit({ roleId, reason: String(data.get("reason") ?? "").trim() }); }}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <p className="role-switch-current">目前：{participant.roleSnapshot.name} · v{participant.roleSnapshot.version}</p>
      <label>切換角色<select value={roleId} onChange={(event) => setRoleId(event.currentTarget.value)} disabled={busy} required>{availableRoles.map((role) => <option key={role.id} value={role.id}>{role.name} · v{role.version}</option>)}</select></label>
      <label>切換原因 <span className="optional-label">選填</span><textarea name="reason" rows={3} maxLength={500} placeholder="例如：改由安全審查角色接手" disabled={busy} /></label>
      <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || noChange}>{busy ? "切換中" : applyingNewVersion ? "套用新版角色" : "切換角色"}</button></div>
    </form>
  </Modal>;
}
