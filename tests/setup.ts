import "dotenv/config";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("Set TEST_DATABASE_URL to a dedicated PostgreSQL database before running the API tests.");
}
const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.slice(1));
if (!databaseName.endsWith("_test")) {
  throw new Error("API tests are destructive and require a database name ending in _test.");
}

process.env.DATABASE_URL = testDatabaseUrl;
process.env.AUTH_SECRET ??= "test-only-auth-secret-never-use-outside-tests";
process.env.NODE_ENV = "test";
