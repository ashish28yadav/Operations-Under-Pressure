import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const apiPort = process.env.PORT ?? environment.PORT ?? "3000";

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`,
      },
    },
    test: {
      environment: "node",
      include: ["tests/**/*.test.ts"],
      setupFiles: ["./tests/setup.ts"],
      fileParallelism: false,
    },
  };
});
