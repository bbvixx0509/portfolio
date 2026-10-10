export type NoDoRuntimeMode = "emulator" | "cloud-auth";

export function resolveRuntimeMode(value: string | undefined): NoDoRuntimeMode {
  if (!value || value === "emulator") {
    return "emulator";
  }

  if (value === "cloud-auth") {
    return "cloud-auth";
  }

  throw new Error(
    "VITE_NODO_RUNTIME_MODE는 emulator 또는 cloud-auth만 사용할 수 있습니다.",
  );
}

export function resolveDeploymentRuntimeMode(
  value: string | undefined,
  isProduction: boolean,
): NoDoRuntimeMode {
  if (isProduction && value !== "cloud-auth") {
    throw new Error(
      "운영 NoDo는 VITE_NODO_RUNTIME_MODE=cloud-auth 설정이 필요합니다.",
    );
  }
  return resolveRuntimeMode(value);
}

export const runtimeMode = resolveDeploymentRuntimeMode(
  import.meta.env.VITE_NODO_RUNTIME_MODE,
  import.meta.env.PROD,
);

export const isCloudAuthMode = runtimeMode === "cloud-auth";
