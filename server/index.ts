import { app, port } from "./app.js";
import { prisma } from "./db.js";

try {
  await prisma.$connect();
  const server = app.listen(port, () => {
    console.info(`Newtonite API listening on http://localhost:${port}`);
  });

  const shutdown = (signal: string) => {
    console.info(`Received ${signal}; closing the API server.`);
    server.close(() => {
      void prisma.$disconnect().then(() => {
        process.exit(0);
      });
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
} catch (error) {
  console.error("The API server could not start.", error);
  await prisma.$disconnect();
  process.exitCode = 1;
}
