import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express, { type ErrorRequestHandler } from "express";
import { ApiError, errorBody } from "./errors.js";
import { env } from "./env.js";
import { apiRouter } from "./routes.js";

export const app = express();

app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use("/api", apiRouter);
app.use("/api", (_request, response) => {
  response.status(404).json(errorBody("NOT_FOUND", "The requested API endpoint was not found."));
});

const staticDirectory = resolve(process.cwd(), "dist");
if (existsSync(resolve(staticDirectory, "index.html"))) {
  app.use(express.static(staticDirectory, { index: false }));
  app.get("/{*path}", (_request, response) => {
    response.sendFile(resolve(staticDirectory, "index.html"));
  });
}

app.use((_request, response) => {
  response.status(404).json(errorBody("NOT_FOUND", "The requested resource was not found."));
});

const errorHandler: ErrorRequestHandler = (error: unknown, request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof ApiError) {
    response.status(error.status).json(errorBody(error.code, error.message, error.details));
    return;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed"
  ) {
    response.status(400).json(errorBody("INVALID_JSON", "The request body must contain valid JSON."));
    return;
  }

  console.error("Unhandled request error", {
    method: request.method,
    path: request.path,
    error,
  });
  response
    .status(500)
    .json(errorBody("INTERNAL_SERVER_ERROR", "The server could not complete the request."));
};

app.use(errorHandler);

export const port = env.PORT;
