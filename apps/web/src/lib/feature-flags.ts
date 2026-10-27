const configuredGoalRunFlag = process.env.NEXT_PUBLIC_GOAL_RUN_AUTONOMY_ENABLED;

export const goalRunAutonomyUiEnabled = configuredGoalRunFlag === "true"
  || (configuredGoalRunFlag !== "false" && process.env.NODE_ENV !== "production");

export const disposableTestLoginUiEnabled = process.env.NEXT_PUBLIC_TEST_LOGIN_ENABLED === "true";
export const tailnetQuickLoginUiEnabled = process.env.NEXT_PUBLIC_TAILNET_QUICK_LOGIN_ENABLED === "true";
export const ompRuntimeUiEnabled = process.env.NEXT_PUBLIC_OMP_RUNTIME_ENABLED === "true";
