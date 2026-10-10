import { BrowserRouter } from "react-router-dom";
import { isCloudAuthMode } from "../config/runtimeMode";
import { AppRoutes } from "./AppRoutes";
import { LocalRealCloudBadge } from "./LocalRealCloudBadge";

export function App() {
  return (
    <BrowserRouter>
      <LocalRealCloudBadge
        visible={
          import.meta.env.DEV
          && isCloudAuthMode
          && import.meta.env.VITE_LOCAL_REAL_NODO_CLOUD === "1"
        }
      />
      <AppRoutes />
    </BrowserRouter>
  );
}
