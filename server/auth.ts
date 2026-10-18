import { createHmac, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "./db.js";
import { ApiError, errorBody } from "./errors.js";
import { env } from "./env.js";

const tokenLifetimeSeconds = 60 * 60 * 8;
const tokenHeader = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

type TokenPayload = { sub: string; iat: number; exp: number };

function signToken(userId: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, iat: issuedAt, exp: issuedAt + tokenLifetimeSeconds }),
  ).toString("base64url");
  const unsigned = `${tokenHeader}.${payload}`;
  const signature = createHmac("sha256", env.AUTH_SECRET).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function verifyToken(token: string): TokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== tokenHeader) {
    throw new ApiError(401, "INVALID_TOKEN", "The authentication token is invalid.");
  }

  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = createHmac("sha256", env.AUTH_SECRET).update(unsigned).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(parts[2], "base64url");
  } catch {
    throw new ApiError(401, "INVALID_TOKEN", "The authentication token is invalid.");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ApiError(401, "INVALID_TOKEN", "The authentication token is invalid.");
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TokenPayload;
  } catch {
    throw new ApiError(401, "INVALID_TOKEN", "The authentication token is invalid.");
  }
  if (
    typeof payload.sub !== "string" ||
    !Number.isInteger(payload.exp) ||
    !Number.isInteger(payload.iat) ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new ApiError(401, "INVALID_TOKEN", "The authentication token has expired.");
  }
  return payload;
}

export const loginInput = z.object({
  email: z.string().trim().max(254).email().transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(200),
});

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  const validPassword = await verifyPassword(
    password,
    user?.passwordHash ?? `0000000000000000:${"0".repeat(128)}`,
  );
  if (!user?.active || !validPassword) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
  }
  return {
    token: signToken(user.id),
    user: { id: user.id, name: user.name, email: user.email },
  };
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [salt, digest] = encoded.split(":");
  if (!salt || !digest) return false;
  const derivedKey = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
  const expected = Buffer.from(digest, "hex");
  return expected.length === derivedKey.length && timingSafeEqual(expected, derivedKey);
}

declare global {
  namespace Express {
    interface Request {
      authUserId?: string;
    }
  }
}

export async function authenticate(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = request.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      throw new ApiError(401, "AUTHENTICATION_REQUIRED", "A bearer token is required.");
    }
    const payload = verifyToken(header.slice("Bearer ".length));
    const user = await prisma.user.findFirst({
      where: { id: payload.sub, active: true },
      select: { id: true },
    });
    if (!user) {
      throw new ApiError(401, "INVALID_TOKEN", "The account is no longer active.");
    }
    request.authUserId = user.id;
    next();
  } catch (error) {
    if (error instanceof ApiError) {
      response.status(error.status).json(errorBody(error.code, error.message));
      return;
    }
    next(error);
  }
}
